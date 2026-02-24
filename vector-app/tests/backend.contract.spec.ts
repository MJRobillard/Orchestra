import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import snapshot from "@/mock_responses/workflow.snapshot.json";
import actionRequests from "@/mock_responses/action.requests.json";
import phaseUpdatedEvent from "@/mock_responses/sse.phase_updated.json";
import {
  ACTION_ENDPOINTS,
  CONTRACT_VERSION,
  PHASE_STATUSES,
  WORKFLOW_EVENT_TYPES,
  type WorkflowActionRequest,
  type WorkflowSnapshot,
} from "@/contracts/workflow-contract";
import { applyActionResponse } from "@/contracts/workflow-state";
import * as workflowEngine from "@/backend/workflow-engine";
import { createHeartbeatEvent, subscribeToRunEvents } from "@/backend/workflow-events";
import { GET as workflowStreamGet } from "@/app/api/workflows/[runId]/stream/route";
import { callLlmForPhase, resolveLlmProvider } from "@/backend/llm-client";
import { POST as startPhasePost } from "@/app/api/workflows/[runId]/phases/[phaseId]/start/route";
import { POST as retryPhasePost } from "@/app/api/workflows/[runId]/phases/[phaseId]/retry/route";
import { POST as resetWorkflowPost } from "@/app/api/workflows/[runId]/reset/route";
import { GET as phaseArtifactsGet } from "@/app/api/workflows/[runId]/phases/[phaseId]/artifacts/route";
import { clearWorkflowDb } from "@/backend/workflow-db";

function parseSseChunk(chunk: string): { eventType: string; data: unknown } {
  const lines = chunk.trim().split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));

  if (!eventLine || !dataLine) {
    throw new Error(`Invalid SSE chunk: ${chunk}`);
  }

  return {
    eventType: eventLine.replace("event: ", "").trim(),
    data: JSON.parse(dataLine.replace("data: ", "")),
  };
}

function getHeaderValue(headers: HeadersInit | undefined, key: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return headers.get(key) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const match = headers.find(([headerKey]) => headerKey.toLowerCase() === key.toLowerCase());
    return match?.[1];
  }

  const record = headers as Record<string, string>;
  const pair = Object.entries(record).find(([headerKey]) => headerKey.toLowerCase() === key.toLowerCase());
  return pair?.[1];
}

function shouldRunRealLlmCheck(): boolean {
  return process.env.runLLMCheck === "1" || process.env.RUN_LLM_CHECK === "1";
}

function getDeepseekKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.DEEPSEEK_API_KEY ?? env.DEEPSEEK;
}

function withEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
  };
}

function withTemporaryEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return fn().finally(() => {
    for (const key of Object.keys(overrides)) {
      const prior = previous[key];
      if (typeof prior === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  });
}

function readPersistedRunSnapshot(runId: string): WorkflowSnapshot | null {
  const dbPath = join(process.cwd(), ".data", "workflow-db.json");
  try {
    const raw = readFileSync(dbPath, "utf8");
    const parsed = JSON.parse(raw) as { runs?: Record<string, WorkflowSnapshot> };
    return parsed.runs?.[runId] ?? null;
  } catch {
    return null;
  }
}

test.describe("Team A contract sync", () => {
  test.describe.configure({ mode: "serial" });

  test("workflow snapshot mock matches DAG contract", () => {
    const data = snapshot as WorkflowSnapshot;

    expect(data.runId).toBeTruthy();
    expect(data.nodes.length).toBeGreaterThan(0);
    expect(data.edges.length).toBeGreaterThan(0);

    const phaseIds = new Set(data.nodes.map((node) => node.phaseId));

    for (const node of data.nodes) {
      expect(PHASE_STATUSES).toContain(node.status);
      for (const dependency of node.dependsOn) {
        expect(phaseIds.has(dependency)).toBeTruthy();
      }
      expect(data.phases[node.phaseId]).toBeDefined();
      expect(data.phases[node.phaseId].status).toBe(node.status);
    }

    for (const edge of data.edges) {
      expect(phaseIds.has(edge.from)).toBeTruthy();
      expect(phaseIds.has(edge.to)).toBeTruthy();
    }
  });

  test("action request mocks stay aligned with accepted action API", () => {
    const requests = Object.values(actionRequests) as WorkflowActionRequest[];

    for (const request of requests) {
      expect(["START_PHASE", "APPROVE_PHASE", "REJECT_PHASE", "RETRY_PHASE"]).toContain(request.action);
      expect(request.runId).toBeTruthy();
      expect(request.phaseId).toBeTruthy();
      expect(request.actorId).toBeTruthy();
    }

    expect(ACTION_ENDPOINTS.start).toContain(":runId");
    expect(ACTION_ENDPOINTS.start).toContain(":phaseId");
    expect(ACTION_ENDPOINTS.approve).toContain("approve");
    expect(ACTION_ENDPOINTS.retry).toContain("retry");
  });

  test("phase_updated event mock conforms to SSE contract", () => {
    expect(WORKFLOW_EVENT_TYPES).toContain(phaseUpdatedEvent.eventType);
    expect(phaseUpdatedEvent.eventType).toBe("phase_updated");
    expect(PHASE_STATUSES).toContain(phaseUpdatedEvent.phase.previousStatus);
    expect(PHASE_STATUSES).toContain(phaseUpdatedEvent.phase.status);
    expect(phaseUpdatedEvent.phase.phaseId).toBeTruthy();
    expect(phaseUpdatedEvent.eventId).toBeTruthy();
    expect(phaseUpdatedEvent.runId).toBeTruthy();
  });

  test("contract version is pinned for both teams", () => {
    expect(CONTRACT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.v\d+$/);
  });

  test("backend runner serves snapshot shape for any run id", () => {
    const seeded = workflowEngine.getWorkflowSnapshot("run_milestone_1_backend");

    expect(seeded.runId).toBe("run_milestone_1_backend");
    expect(Array.isArray(seeded.nodes)).toBeTruthy();
    expect(Array.isArray(seeded.edges)).toBeTruthy();
    expect(Object.keys(seeded.phases).length).toBeGreaterThan(0);
  });

  test("backend runner applies action and emits phase_updated event", () => {
    const request = actionRequests.startPhase as WorkflowActionRequest;
    const runId = "run_milestone_1_action";
    const phaseId = request.phaseId;

    const before = workflowEngine.getWorkflowSnapshot(runId);
    const previousStatus = before.phases[phaseId].status;

    const result = workflowEngine.applyWorkflowAction({
      ...request,
      runId,
    });

    expect(result.response.accepted).toBeTruthy();
    expect(result.response.phaseId).toBe(phaseId);
    expect(PHASE_STATUSES).toContain(result.response.status);
    expect(result.event.eventType).toBe("phase_updated");
    if (result.event.eventType !== "phase_updated") {
      throw new Error(`Expected phase_updated event, received ${result.event.eventType}`);
    }
    expect(result.event.phase.phaseId).toBe(phaseId);
    expect(result.event.phase.previousStatus).toBe(previousStatus);
  });

  test("heartbeat factory emits valid heartbeat contract events", () => {
    const heartbeat = createHeartbeatEvent("run_milestone_2_heartbeat", 7);

    expect(heartbeat.eventType).toBe("heartbeat");
    expect(heartbeat.sequence).toBe(7);
    expect(heartbeat.runId).toBe("run_milestone_2_heartbeat");
    expect(heartbeat.eventId).toBeTruthy();
    expect(heartbeat.emittedAt).toBeTruthy();
  });

  test("phase actions publish phase_updated to run subscribers", () => {
    const request = actionRequests.startPhase as WorkflowActionRequest;
    const runId = "run_milestone_2_publish";
    let capturedType: string | undefined;
    let capturedPhaseId: string | undefined;

    const unsubscribe = subscribeToRunEvents(runId, (event) => {
      capturedType = event.eventType;
      if (event.eventType === "phase_updated") {
        capturedPhaseId = event.phase.phaseId;
      }
    });

    workflowEngine.applyWorkflowAction({
      ...request,
      runId,
    });
    unsubscribe();

    expect(capturedType).toBe("phase_updated");
    expect(capturedPhaseId).toBe(request.phaseId);
  });

  test("listener failures do not break action application", () => {
    const runId = "run_milestone_2_listener_fault";
    const request = actionRequests.startPhase as WorkflowActionRequest;
    const unsubscribe = subscribeToRunEvents(runId, () => {
      throw new Error("listener failed");
    });

    expect(() =>
      workflowEngine.applyWorkflowAction({
        ...request,
        runId,
      }),
    ).not.toThrow();

    unsubscribe();
  });

  test("stream endpoint emits contract events and forwards phase updates", async () => {
    const runId = "run_milestone_2_stream";
    const request = actionRequests.startPhase as WorkflowActionRequest;
    const response = await workflowStreamGet(new Request(`http://localhost/api/workflows/${runId}/stream`), {
      params: Promise.resolve({ runId }),
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body).not.toBeNull();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const firstRead = await reader.read();
    expect(firstRead.done).toBeFalsy();
    const firstChunk = decoder.decode(firstRead.value);
    const firstEvent = parseSseChunk(firstChunk);
    expect(WORKFLOW_EVENT_TYPES).toContain(firstEvent.eventType as (typeof WORKFLOW_EVENT_TYPES)[number]);
    expect(firstEvent.eventType).toBe("heartbeat");

    workflowEngine.applyWorkflowAction({
      ...request,
      runId,
    });

    const secondRead = await reader.read();
    expect(secondRead.done).toBeFalsy();
    const secondChunk = decoder.decode(secondRead.value);
    const secondEvent = parseSseChunk(secondChunk);
    expect(secondEvent.eventType).toBe("phase_updated");

    await reader.cancel();
  });

  test("TESTING=1 routes LLM calls through DeepSeek key", async () => {
    let capturedAuthHeader: string | undefined;
    let capturedUrl = "";
    const fetchMock: typeof fetch = (async (input, init) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedAuthHeader = getHeaderValue(init?.headers, "authorization");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    const result = await callLlmForPhase({
      runId: "run_env_test_1",
      phaseId: "phase_b",
      prompt: "test prompt",
      env: withEnv({
        TESTING: "1",
        DEEPSEEK_API_KEY: "deepseek_test_key",
        DEEPSEEK: "deepseek_test_key",
        ANTHROPIC_API_KEY: "anthropic_test_key",
        ANTHROPIC: "anthropic_test_key",
      }),
      fetchImpl: fetchMock,
    });

    expect(resolveLlmProvider(withEnv({ TESTING: "1" }))).toBe("deepseek");
    expect(result.provider).toBe("deepseek");
    expect(capturedUrl).toContain("deepseek.com");
    expect(capturedAuthHeader).toBe("Bearer deepseek_test_key");
  });

  test("LLM=ANTHROPIC overrides TESTING=1", () => {
    expect(
      resolveLlmProvider(
        withEnv({
          LLM: "ANTHROPIC",
          TESTING: "1",
        }),
      ),
    ).toBe("anthropic");
  });

  test("runLLMCheck makes a real DeepSeek network call", async () => {
    test.skip(!shouldRunRealLlmCheck(), "Set RUN_LLM_CHECK=1 (or runLLMCheck=1) to enable live DeepSeek check");

    const deepseekKey = getDeepseekKey(process.env);
    expect(deepseekKey, "DEEPSEEK_API_KEY or DEEPSEEK env var is required for real LLM check").toBeTruthy();

    const result = await callLlmForPhase({
      runId: "run_real_llm_check",
      phaseId: "phase_b",
      prompt: "Reply with exactly: DEEPSEEK_OK",
      env: withEnv({
        TESTING: "1",
        DEEPSEEK_API_KEY: deepseekKey,
        DEEPSEEK: deepseekKey,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        ANTHROPIC: process.env.ANTHROPIC,
      }),
    });

    expect(result.provider).toBe("deepseek");
    expect(result.content.length).toBeGreaterThan(0);
  });

  test("milestone 4 persists LLM artifacts and serves them via phase artifacts API", async () => {
    clearWorkflowDb();
    const runId = "run_milestone_4_artifacts";
    const phaseId = "phase_b";

    const originalFetch = globalThis.fetch;
    const fetchMock: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Mock persisted diff output" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    globalThis.fetch = fetchMock;

    await withTemporaryEnv(
      {
        TESTING: "1",
        DEEPSEEK: "deepseek_test_key",
        ANTHROPIC: "anthropic_test_key",
      },
      async () => {
        try {
          const startResponse = await startPhasePost(
            new Request(`http://localhost/api/workflows/${runId}/phases/${phaseId}/start`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "START_PHASE",
                actorId: "system:runner",
                payload: {
                  prompt: "Generate a meaningful diff",
                },
              }),
            }),
            { params: Promise.resolve({ runId, phaseId }) },
          );

          expect(startResponse.status).toBe(200);
          const startJson = (await startResponse.json()) as {
            llmProvider?: string;
            artifacts?: Array<{ artifactId: string; kind: string; uri: string }>;
          };
          expect(startJson.llmProvider).toBe("deepseek");
          expect(startJson.artifacts?.length).toBeGreaterThanOrEqual(2);

          const snapshotAfter = workflowEngine.getWorkflowSnapshot(runId);
          expect(snapshotAfter.phases[phaseId].output?.diff).toContain("Mock persisted diff output");
          expect(snapshotAfter.phases[phaseId].output?.uiSchema?.version).toBe(1);
          const uiTree = snapshotAfter.phases[phaseId].output?.uiSchema?.tree;
          expect(Array.isArray(uiTree) ? uiTree.length : 0).toBeGreaterThan(0);
          expect(snapshotAfter.phases[phaseId].status).toBe("APPROVED");
          expect(snapshotAfter.phases[phaseId].artifacts.length).toBeGreaterThanOrEqual(2);

          const artifactsResponse = await phaseArtifactsGet(
            new Request(`http://localhost/api/workflows/${runId}/phases/${phaseId}/artifacts`),
            { params: Promise.resolve({ runId, phaseId }) },
          );
          expect(artifactsResponse.status).toBe(200);

          const artifactsJson = (await artifactsResponse.json()) as {
            artifacts: Array<{ kind: string; data: unknown }>;
          };
          expect(artifactsJson.artifacts.length).toBeGreaterThanOrEqual(2);
          expect(artifactsJson.artifacts.some((artifact) => artifact.kind === "diff")).toBeTruthy();
          expect(artifactsJson.artifacts.some((artifact) => artifact.kind === "rubric")).toBeTruthy();
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    );
  });

  test("reset workflow endpoint re-seeds run to Phase A gate", async () => {
    clearWorkflowDb();
    const runId = "run_reset_poc";

    // Hydrate and mutate first.
    workflowEngine.applyWorkflowAction({
      action: "START_PHASE",
      runId,
      phaseId: "phase_a",
      actorId: "user:ui",
    });

    const response = await resetWorkflowPost(
      new Request(`http://localhost/api/workflows/${runId}/reset`, { method: "POST" }),
      { params: Promise.resolve({ runId }) },
    );
    expect(response.status).toBe(200);
    const resetSnapshot = (await response.json()) as WorkflowSnapshot;
    expect(resetSnapshot.phases.phase_a.status).toBe("DRAFT");
    expect(resetSnapshot.phases.phase_b.status).toBe("BLOCKED");
    expect(resetSnapshot.phases.phase_c.status).toBe("BLOCKED");
  });

  test("Phase A context init accepts human payload, calls LLM, and auto-approves gate", async () => {
    clearWorkflowDb();
    const runId = "run_phase_a_context_init";
    const phaseId = "phase_a";

    const originalFetch = globalThis.fetch;
    const fetchMock: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Goals: modernize onboarding UI" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    globalThis.fetch = fetchMock;

    await withTemporaryEnv(
      {
        TESTING: "1",
        DEEPSEEK: "deepseek_test_key",
        ANTHROPIC: "anthropic_test_key",
      },
      async () => {
        try {
          const response = await startPhasePost(
            new Request(`http://localhost/api/workflows/${runId}/phases/${phaseId}/start`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "START_PHASE",
                actorId: "human:designer_01",
                payload: {
                  intent: "Redesign onboarding flow for better completion rates",
                  tokens: "primary=#3B82F6; radius=8",
                  rubric: "WCAG AA; no layout shift",
                  branchFactor: 4,
                },
              }),
            }),
            { params: Promise.resolve({ runId, phaseId }) },
          );

          expect(response.status).toBe(200);
          const json = (await response.json()) as {
            accepted: boolean;
            status: string;
            llmProvider?: string;
            artifacts?: Array<{ kind: string }>;
            autoStartedPhases?: string[];
          };
          expect(json.accepted).toBeTruthy();
          expect(json.status).toBe("APPROVED");
          expect(json.llmProvider).toBe("deepseek");
          expect(json.artifacts?.length).toBeGreaterThanOrEqual(3);
          expect(json.autoStartedPhases).toEqual(["phase_b", "phase_c"]);

          const snapshotAfter = workflowEngine.getWorkflowSnapshot(runId);
          expect(snapshotAfter.phases[phaseId].status).toBe("APPROVED");
          expect(snapshotAfter.phases[phaseId].output?.details?.contextArtifact).toBeTruthy();
          expect(snapshotAfter.phases[phaseId].output?.uiSchema?.version).toBe(1);
          expect(snapshotAfter.phases.phase_b.status).toBe("APPROVED");
          expect(snapshotAfter.phases.phase_c.status).toBe("APPROVED");
          expect(snapshotAfter.phases.phase_b.output).toBeTruthy();
          expect(snapshotAfter.phases.phase_c.output).toBeTruthy();
          const generatedVariants = snapshotAfter.phases.phase_d.output?.details?.generatedVariants;
          expect(Array.isArray(generatedVariants)).toBeTruthy();
          expect(Array.isArray(generatedVariants) ? generatedVariants.length : 0).toBe(4);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    );
  });

  test("Phase A permutation fan-out is resilient: one failure still returns the other branch", async () => {
    clearWorkflowDb();
    const runId = "run_phase_a_all_settled";
    const phaseId = "phase_a";

    const originalFetch = globalThis.fetch;
    let callCount = 0;
    const fetchMock: typeof fetch = (async () => {
      callCount += 1;
      if (callCount === 3) {
        return new Response(
          JSON.stringify({ error: { message: "simulated provider failure" } }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `mock content ${callCount}` } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    await withTemporaryEnv(
      {
        TESTING: "1",
        DEEPSEEK: "deepseek_test_key",
        ANTHROPIC: "anthropic_test_key",
      },
      async () => {
        try {
          const response = await startPhasePost(
            new Request(`http://localhost/api/workflows/${runId}/phases/${phaseId}/start`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "START_PHASE",
                actorId: "human:designer_01",
                payload: {
                  intent: "Generate two variants even if one provider call fails",
                },
              }),
            }),
            { params: Promise.resolve({ runId, phaseId }) },
          );

          expect(response.status).toBe(200);
          const json = (await response.json()) as {
            autoStartedPhases?: string[];
            autoStartErrors?: string[];
          };
          expect(json.autoStartedPhases?.length).toBe(1);
          expect(json.autoStartErrors?.length).toBe(1);

          const snapshotAfter = workflowEngine.getWorkflowSnapshot(runId);
          const successfulPhases = ["phase_b", "phase_c"].filter(
            (candidate) => snapshotAfter.phases[candidate].status === "APPROVED",
          );
          expect(successfulPhases.length).toBe(1);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    );
  });

  test("Phase D merge review submits human explanation and exits RUNNING", async () => {
    clearWorkflowDb();
    const runId = "run_phase_d_merge_review";

    workflowEngine.applyWorkflowAction({
      action: "APPROVE_PHASE",
      runId,
      phaseId: "phase_a",
      actorId: "test:runner",
    });
    workflowEngine.applyWorkflowAction({
      action: "APPROVE_PHASE",
      runId,
      phaseId: "phase_b",
      actorId: "test:runner",
    });
    workflowEngine.applyWorkflowAction({
      action: "APPROVE_PHASE",
      runId,
      phaseId: "phase_c",
      actorId: "test:runner",
    });

    const response = await startPhasePost(
      new Request(`http://localhost/api/workflows/${runId}/phases/phase_d/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "START_PHASE",
          actorId: "human:reviewer_01",
          payload: {
            mergerExplanation: "Merge stronger hierarchy from B with lighter spacing from C.",
          },
        }),
      }),
      { params: Promise.resolve({ runId, phaseId: "phase_d" }) },
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as { accepted: boolean; status: string; autoStartedPhases?: string[] };
    expect(json.accepted).toBeTruthy();
    expect(json.status).toBe("APPROVED");
    expect(json.autoStartedPhases).toContain("phase_e");

    const snapshotAfter = workflowEngine.getWorkflowSnapshot(runId);
    expect(snapshotAfter.phases.phase_d.status).toBe("APPROVED");
    expect(snapshotAfter.phases.phase_d.output?.details?.mergerExplanation).toContain("Merge stronger hierarchy");
    expect(snapshotAfter.phases.phase_e.status).toBe("COMPLETED");
    expect(snapshotAfter.phases.phase_e.output).toBeTruthy();
    expect(
      Boolean(snapshotAfter.phases.phase_e.output?.uiCode) || Boolean(snapshotAfter.phases.phase_e.output?.uiSchema),
    ).toBeTruthy();
  });

  test("Phase E induction refines only a targeted component subset via RETRY_PHASE", async () => {
    clearWorkflowDb();
    const runId = "run_phase_e_induction";

    const originalFetch = globalThis.fetch;
    const fetchMock: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              content:
                '{"renderMode":"code","uiCode":{"language":"html","code":"<main><section id=\\"hero\\"><button id=\\"hero-cta\\">Refined CTA</button></section></main>"},"diff":"Scoped edit applied to #hero-cta","rubricResults":[{"criterion":"Scoped component refinement","score":5,"maxScore":5}]}',
            },
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    globalThis.fetch = fetchMock;

    await withTemporaryEnv(
      {
        TESTING: "1",
        DEEPSEEK: "deepseek_test_key",
        ANTHROPIC: "anthropic_test_key",
      },
      async () => {
        try {
          workflowEngine.applyWorkflowAction({
            action: "APPROVE_PHASE",
            runId,
            phaseId: "phase_a",
            actorId: "test:runner",
          });
          workflowEngine.applyWorkflowAction({
            action: "APPROVE_PHASE",
            runId,
            phaseId: "phase_b",
            actorId: "test:runner",
          });
          workflowEngine.applyWorkflowAction({
            action: "APPROVE_PHASE",
            runId,
            phaseId: "phase_c",
            actorId: "test:runner",
          });

          await startPhasePost(
            new Request(`http://localhost/api/workflows/${runId}/phases/phase_d/start`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "START_PHASE",
                actorId: "human:reviewer_01",
                payload: {
                  mergerExplanation: "Merge B/C and proceed",
                },
              }),
            }),
            { params: Promise.resolve({ runId, phaseId: "phase_d" }) },
          );

          const refineResponse = await retryPhasePost(
            new Request(`http://localhost/api/workflows/${runId}/phases/phase_e/retry`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "RETRY_PHASE",
                actorId: "human:reviewer_01",
                payload: {
                  componentSelector: "<main",
                  refinementPrompt: "Improve only the CTA styling and keep everything else stable.",
                },
              }),
            }),
            { params: Promise.resolve({ runId, phaseId: "phase_e" }) },
          );

          expect(refineResponse.status).toBe(200);
          const snapshotAfter = workflowEngine.getWorkflowSnapshot(runId);
          expect(snapshotAfter.phases.phase_e.status).toBe("COMPLETED");
          expect(snapshotAfter.phases.phase_e.output?.details?.scopedRefinement).toBeTruthy();
          expect(snapshotAfter.phases.phase_e.output?.details?.componentSelector).toBe("<main");
          expect(snapshotAfter.phases.phase_e.output?.diff).toContain("Scoped");
          const generatedRefinements = snapshotAfter.phases.phase_e.output?.details?.generatedRefinements;
          expect(Array.isArray(generatedRefinements)).toBeTruthy();
          expect(Array.isArray(generatedRefinements) ? generatedRefinements.length : 0).toBe(2);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    );
  });

  test("Phase E induction rejects selector that is not present in final HTML", async () => {
    clearWorkflowDb();
    const runId = "run_phase_e_induction_missing_selector";

    workflowEngine.applyWorkflowAction({
      action: "APPROVE_PHASE",
      runId,
      phaseId: "phase_a",
      actorId: "test:runner",
    });
    workflowEngine.applyWorkflowAction({
      action: "APPROVE_PHASE",
      runId,
      phaseId: "phase_b",
      actorId: "test:runner",
    });
    workflowEngine.applyWorkflowAction({
      action: "APPROVE_PHASE",
      runId,
      phaseId: "phase_c",
      actorId: "test:runner",
    });

    await startPhasePost(
      new Request(`http://localhost/api/workflows/${runId}/phases/phase_d/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "START_PHASE",
          actorId: "human:reviewer_01",
          payload: {
            mergerExplanation: "Complete baseline merge first",
          },
        }),
      }),
      { params: Promise.resolve({ runId, phaseId: "phase_d" }) },
    );

    const refineResponse = await retryPhasePost(
      new Request(`http://localhost/api/workflows/${runId}/phases/phase_e/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "RETRY_PHASE",
          actorId: "human:reviewer_01",
          payload: {
            componentSelector: "#definitely-not-in-html",
            refinementPrompt: "Try to update this missing node",
          },
        }),
      }),
      { params: Promise.resolve({ runId, phaseId: "phase_e" }) },
    );

    expect(refineResponse.status).toBe(400);
    const body = (await refineResponse.json()) as { accepted: boolean; message?: string };
    expect(body.accepted).toBeFalsy();
    expect(body.message).toContain("was not found");
  });

  test("retry scopes artifact reads to latest attempt only", async () => {
    clearWorkflowDb();
    const runId = "run_milestone_4_retry_scope";
    const phaseId = "phase_b";

    const originalFetch = globalThis.fetch;
    let llmResponseText = "diff attempt 1";
    const fetchMock: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: llmResponseText } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    globalThis.fetch = fetchMock;

    await withTemporaryEnv(
      {
        TESTING: "1",
        DEEPSEEK: "deepseek_test_key",
        ANTHROPIC: "anthropic_test_key",
      },
      async () => {
        try {
          await startPhasePost(
            new Request(`http://localhost/api/workflows/${runId}/phases/${phaseId}/start`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "START_PHASE",
                actorId: "system:runner",
              }),
            }),
            { params: Promise.resolve({ runId, phaseId }) },
          );

          llmResponseText = "diff attempt 2";
          await retryPhasePost(
            new Request(`http://localhost/api/workflows/${runId}/phases/${phaseId}/retry`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "RETRY_PHASE",
                actorId: "human:reviewer_01",
                reason: "Please regenerate",
              }),
            }),
            { params: Promise.resolve({ runId, phaseId }) },
          );

          const artifactsResponse = await phaseArtifactsGet(
            new Request(`http://localhost/api/workflows/${runId}/phases/${phaseId}/artifacts`),
            { params: Promise.resolve({ runId, phaseId }) },
          );
          const artifactsJson = (await artifactsResponse.json()) as {
            artifacts: Array<{ data: { diff?: string; output?: { diff?: string } } }>;
          };

          const serialized = JSON.stringify(artifactsJson.artifacts);
          expect(serialized).toContain("diff attempt 2");
          expect(serialized).not.toContain("diff attempt 1");
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    );
  });

  test("snapshot phase output is durable in DB across restart boundary", async () => {
    clearWorkflowDb();
    const runId = "run_milestone_4_restart";
    const phaseId = "phase_b";

    // Simulate restart durability by verifying phase output in DB-backed run snapshot.
    // This avoids relying on in-memory map internals in tests.
    const persistedBefore = readPersistedRunSnapshot(runId);
    expect(persistedBefore).toBeNull();

    const originalFetch = globalThis.fetch;
    const fetchMock: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "durable diff payload" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    globalThis.fetch = fetchMock;

    await withTemporaryEnv(
      {
        TESTING: "1",
        DEEPSEEK: "deepseek_test_key",
        ANTHROPIC: "anthropic_test_key",
      },
      async () => {
        try {
          await startPhasePost(
            new Request(`http://localhost/api/workflows/${runId}/phases/${phaseId}/start`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "START_PHASE",
                actorId: "system:runner",
              }),
            }),
            { params: Promise.resolve({ runId, phaseId }) },
          );

          const restored = readPersistedRunSnapshot(runId);
          expect(restored).not.toBeNull();
          if (!restored) {
            throw new Error("Expected run snapshot in DB after write");
          }
          expect(restored.phases[phaseId].output?.diff).toContain("durable diff payload");
          expect(restored.phases[phaseId].artifacts.length).toBeGreaterThan(0);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    );
  });

  test("M3 integration: applyActionResponse alone misses unblocked dependents — re-fetch resolves desync", () => {
    // DAG: phase_a(COMPLETED) → phase_b, phase_c → phase_d(BLOCKED) → phase_e(BLOCKED)
    //
    // Scenario: both parallel LLM phases are approved in sequence. The backend's
    // unblockDependents() silently flips phase_d BLOCKED→DRAFT when phase_c is
    // approved (because both dependencies are now APPROVED). No SSE event is
    // emitted for phase_d. applyActionResponse() only touches the targeted phase,
    // so the frontend DAG would show phase_d as BLOCKED until a re-fetch.
    clearWorkflowDb();
    const runId = "run_m3_desync_check";

    // Backend: approve phase_b — phase_d still BLOCKED (only one dependency met)
    const approveB = workflowEngine.applyWorkflowAction({
      action: "APPROVE_PHASE",
      runId,
      phaseId: "phase_b",
      actorId: "test:runner",
    });
    expect(approveB.response.accepted).toBeTruthy();

    // Capture the snapshot a frontend client would hold at this point
    const frontendSnapshot = workflowEngine.getWorkflowSnapshot(runId);
    expect(frontendSnapshot.phases["phase_b"].status).toBe("APPROVED");
    expect(frontendSnapshot.phases["phase_d"].status).toBe("BLOCKED");

    // Backend: approve phase_c — triggers unblockDependents on phase_d
    const approveC = workflowEngine.applyWorkflowAction({
      action: "APPROVE_PHASE",
      runId,
      phaseId: "phase_c",
      actorId: "test:runner",
    });
    expect(approveC.response.accepted).toBeTruthy();

    // ── The desync ──────────────────────────────────────────────────────────
    // Frontend applies only the targeted phase update — phase_d is still BLOCKED.
    const frontendAfterC = applyActionResponse(frontendSnapshot, approveC.response);
    expect(frontendAfterC.phases["phase_c"].status).toBe("APPROVED");
    expect(frontendAfterC.phases["phase_d"].status).toBe("BLOCKED"); // ← stale

    // ── The fix: re-fetch the authoritative snapshot ────────────────────────
    // usePhaseAction now fires a background GET /api/workflows/:runId after every
    // successful action, replacing the full store snapshot.
    const authoritative = workflowEngine.getWorkflowSnapshot(runId);
    expect(authoritative.phases["phase_c"].status).toBe("APPROVED");
    expect(authoritative.phases["phase_d"].status).toBe("DRAFT"); // ← correct
  });
});
