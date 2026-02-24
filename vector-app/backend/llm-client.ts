import type { PhaseType } from "@/contracts/workflow-contract";

export type LlmProvider = "deepseek" | "anthropic";

interface LlmCallArgs {
  runId: string;
  phaseId: string;
  prompt: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

interface LlmCallResult {
  provider: LlmProvider;
  content: string;
}

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";

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

export async function callLlmForPhase(args: LlmCallArgs): Promise<LlmCallResult> {
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
      model: "claude-3-5-sonnet-20241022",
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

export function requiresLlmPhaseExecution(phaseType?: PhaseType): boolean {
  return phaseType === "LLM";
}
