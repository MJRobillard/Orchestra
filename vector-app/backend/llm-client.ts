import type { PhaseType } from "@/contracts/workflow-contract";

export type LlmProvider = "deepseek" | "anthropic";

interface LlmCallArgs {
  runId: string;
  phaseId: string;
  prompt: string;
  debugContext?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

interface LlmCallResult {
  provider: LlmProvider;
  content: string;
}

export interface BatchLlmCallItem {
  key: string;
  runId: string;
  phaseId: string;
  prompt: string;
}

export interface BatchLlmCallResultItem {
  key: string;
  taskId?: string;
  status: "SUCCESS" | "FAILURE";
  provider?: LlmProvider;
  content?: string;
  error?: string;
}

interface PythonTaskSubmission {
  taskId?: string;
  status?: string;
}

interface PythonTaskResult {
  provider?: string;
  content?: string;
}

interface PythonTaskState {
  taskId?: string;
  status?: string;
  result?: PythonTaskResult;
  error?: string;
}

interface PythonBatchTaskItem {
  key?: string;
  taskId?: string;
  status?: string;
  result?: PythonTaskResult;
  error?: string;
}

interface PythonBatchResponse {
  groupId?: string;
  tasks?: PythonBatchTaskItem[];
}

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_PYTHON_LLM_TIMEOUT_MS = 120_000;
const DEFAULT_PYTHON_LLM_POLL_INTERVAL_MS = 1_000;

export function resolveLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const explicit = (env.LLM_PROVIDER ?? env.LLM ?? "").trim().toLowerCase();
  if (explicit === "anthropic") return "anthropic";
  if (explicit === "deepseek") return "deepseek";
  return env.TESTING === "1" ? "deepseek" : "anthropic";
}

function getProviderApiKey(provider: LlmProvider, env: NodeJS.ProcessEnv): string {
  if (provider === "deepseek") {
    const key = env.DEEPSEEK ?? env.DEEPSEEK_API_KEY;
    if (!key) throw new Error("DEEPSEEK env var is required for DeepSeek calls");
    return key;
  }

  const key = env.ANTHROPIC ?? env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC env var is required for Anthropic calls");
  return key;
}

function parseTextResponse(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";

  const maybeOpenAi = payload as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (maybeOpenAi.choices?.[0]?.message?.content) {
    return maybeOpenAi.choices[0].message.content;
  }

  const maybeAnthropic = payload as {
    content?: Array<{ text?: string }>;
  };
  if (maybeAnthropic.content?.[0]?.text) {
    return maybeAnthropic.content[0].text;
  }

  return "";
}

function isPythonBackendEnabled(env: NodeJS.ProcessEnv): boolean {
  const explicitToggle = env.PYTHON_BACKEND_ENABLED?.trim();
  if (explicitToggle) return explicitToggle === "1";
  return Boolean(env.PYTHON_BACKEND_URL?.trim());
}

function getPythonBackendUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.PYTHON_BACKEND_URL?.trim();
  if (!raw) {
    throw new Error("PYTHON_BACKEND_URL is required when PYTHON_BACKEND_ENABLED=1");
  }
  return raw.replace(/\/+$/, "");
}

function toPositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProvider(provider: string | undefined, fallback: LlmProvider): LlmProvider {
  if (!provider) return fallback;
  const normalized = provider.toLowerCase().trim();
  if (normalized === "deepseek" || normalized === "anthropic") return normalized;
  return fallback;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function callLlmViaPythonBackend(args: LlmCallArgs): Promise<LlmCallResult> {
  const env = args.env ?? process.env;
  const fetchImpl = args.fetchImpl ?? fetch;
  const provider = resolveLlmProvider(env);
  const baseUrl = getPythonBackendUrl(env);

  const submitResponse = await fetchImpl(`${baseUrl}/llm/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      run_id: args.runId,
      phase_id: args.phaseId,
      prompt: args.prompt,
      provider,
      debug_context: args.debugContext ?? null,
    }),
  });

  if (!submitResponse.ok) {
    throw new Error(`Python backend task submission failed with status ${submitResponse.status}`);
  }

  const submitted = (await submitResponse.json()) as PythonTaskSubmission;
  const taskId = submitted.taskId;
  if (!taskId) throw new Error("Python backend did not return a taskId");

  const timeoutMs = toPositiveNumber(env.PYTHON_LLM_TIMEOUT_MS, DEFAULT_PYTHON_LLM_TIMEOUT_MS);
  const pollIntervalMs = toPositiveNumber(
    env.PYTHON_LLM_POLL_INTERVAL_MS,
    DEFAULT_PYTHON_LLM_POLL_INTERVAL_MS,
  );

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const statusResponse = await fetchImpl(`${baseUrl}/llm/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
    });

    if (!statusResponse.ok) {
      throw new Error(`Python backend task poll failed with status ${statusResponse.status}`);
    }

    const taskState = (await statusResponse.json()) as PythonTaskState;
    if (taskState.status === "SUCCESS") {
      return {
        provider: normalizeProvider(taskState.result?.provider, provider),
        content: taskState.result?.content ?? "",
      };
    }

    if (taskState.status === "FAILURE") {
      throw new Error(taskState.error ?? "Python backend LLM task failed");
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Python backend LLM task timed out after ${timeoutMs}ms`);
}

async function callLlmBatchViaPythonBackend(args: {
  items: BatchLlmCallItem[];
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}): Promise<BatchLlmCallResultItem[]> {
  const provider = resolveLlmProvider(args.env);
  const baseUrl = getPythonBackendUrl(args.env);
  const response = await args.fetchImpl(`${baseUrl}/llm/tasks/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      items: args.items.map((item) => ({
        key: item.key,
        run_id: item.runId,
        phase_id: item.phaseId,
        prompt: item.prompt,
        provider,
      })),
    }),
  });

  if (!response.ok) {
    throw new Error(`Python backend batch submission failed with status ${response.status}`);
  }

  const payload = (await response.json()) as PythonBatchResponse;
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const keyed = new Map(tasks.map((task) => [task.key, task]));

  return args.items.map((item) => {
    const task = keyed.get(item.key);
    if (!task) {
      return {
        key: item.key,
        status: "FAILURE",
        error: "Missing task result from Python backend",
      };
    }
    if (task.status === "SUCCESS") {
      return {
        key: item.key,
        taskId: task.taskId,
        status: "SUCCESS",
        provider: normalizeProvider(task.result?.provider, provider),
        content: task.result?.content ?? "",
      };
    }
    return {
      key: item.key,
      taskId: task.taskId,
      status: "FAILURE",
      error: task.error ?? `Task status was ${task.status ?? "UNKNOWN"}`,
    };
  });
}

async function callLlmBatchDirect(args: {
  items: BatchLlmCallItem[];
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}): Promise<BatchLlmCallResultItem[]> {
  const settled = await Promise.allSettled(
    args.items.map((item) =>
      callLlmDirect({
        runId: item.runId,
        phaseId: item.phaseId,
        prompt: item.prompt,
        env: args.env,
        fetchImpl: args.fetchImpl,
      }),
    ),
  );

  return settled.map((result, index) => {
    const item = args.items[index];
    if (result.status === "fulfilled") {
      return {
        key: item.key,
        status: "SUCCESS",
        provider: result.value.provider,
        content: result.value.content,
      };
    }
    return {
      key: item.key,
      status: "FAILURE",
      error: result.reason instanceof Error ? result.reason.message : "Unknown batch LLM failure",
    };
  });
}

async function callLlmDirect(args: LlmCallArgs): Promise<LlmCallResult> {
  const env = args.env ?? process.env;
  const fetchImpl = args.fetchImpl ?? fetch;
  const provider = resolveLlmProvider(env);
  const apiKey = getProviderApiKey(provider, env);

  if (provider === "deepseek") {
    const response = await fetchImpl(DEEPSEEK_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: args.prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`DeepSeek call failed with status ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    return {
      provider,
      content: parseTextResponse(payload),
    };
  }

  const response = await fetchImpl(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages: [{ role: "user", content: args.prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic call failed with status ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  return {
    provider,
    content: parseTextResponse(payload),
  };
}

export async function callLlmForPhase(args: LlmCallArgs): Promise<LlmCallResult> {
  const env = args.env ?? process.env;
  if (isPythonBackendEnabled(env)) {
    return callLlmViaPythonBackend(args);
  }
  return callLlmDirect(args);
}

export async function callLlmBatch(args: {
  items: BatchLlmCallItem[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<BatchLlmCallResultItem[]> {
  const env = args.env ?? process.env;
  const fetchImpl = args.fetchImpl ?? fetch;
  if (args.items.length === 0) return [];
  if (isPythonBackendEnabled(env)) {
    return callLlmBatchViaPythonBackend({ items: args.items, env, fetchImpl });
  }
  return callLlmBatchDirect({ items: args.items, env, fetchImpl });
}

export function requiresLlmPhaseExecution(phaseType?: PhaseType): boolean {
  return phaseType === "LLM";
}
