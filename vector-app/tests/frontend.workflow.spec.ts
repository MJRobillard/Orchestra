import { test, expect } from "@playwright/test";
import snapshot from "@/mock_responses/workflow.snapshot.json";
import phaseUpdatedEvent from "@/mock_responses/sse.phase_updated.json";
import {
  applyPhaseUpdatedEvent,
  applyActionResponse,
  computeWorkflowCounts,
} from "@/contracts/workflow-state";
import {
  WORKFLOW_EVENT_TYPES,
  type PhaseUpdatedEvent,
  type WorkflowActionResponse,
  type WorkflowNode,
  type WorkflowSnapshot,
} from "@/contracts/workflow-contract";
import {
  getAvailableActions,
  resolveActionUrl,
  buildActionRequest,
} from "@/app/workflow/utils/workflow-actions";

test.describe("Team B workflow state sync", () => {
  test("computes expected counts from workflow snapshot", () => {
    const counts = computeWorkflowCounts(snapshot as WorkflowSnapshot);

    expect(counts.total).toBe(5);
    expect(counts.running).toBe(2);
    expect(counts.humanQueue).toBe(0);
  });

  test("applies phase_updated event to node and phase state", () => {
    const before = snapshot as WorkflowSnapshot;
    const next = applyPhaseUpdatedEvent(before, phaseUpdatedEvent as PhaseUpdatedEvent);

    expect(before.nodes.find((node) => node.phaseId === "phase_b")?.status).toBe("RUNNING");
    expect(next.nodes.find((node) => node.phaseId === "phase_b")?.status).toBe("READY_FOR_REVIEW");
    expect(next.phases.phase_b.status).toBe("READY_FOR_REVIEW");
    expect(next.updatedAt).toBe(phaseUpdatedEvent.emittedAt);
  });

  test("applyActionResponse updates node + phase status when accepted", () => {
    const response: WorkflowActionResponse = {
      accepted: true,
      runId: "run_20260223_001",
      phaseId: "phase_d",
      status: "APPROVED",
      message: "Looks good",
    };
    const before = snapshot as WorkflowSnapshot;
    const next = applyActionResponse(before, response);

    // original must be untouched (structuredClone)
    expect(before.nodes.find((n: WorkflowNode) => n.phaseId === "phase_d")?.status).toBe("BLOCKED");
    // node and phase both updated
    expect(next.nodes.find((n: WorkflowNode) => n.phaseId === "phase_d")?.status).toBe("APPROVED");
    expect(next.phases.phase_d.status).toBe("APPROVED");
  });

  test("applyActionResponse is a no-op when not accepted", () => {
    const response: WorkflowActionResponse = {
      accepted: false,
      runId: "run_20260223_001",
      phaseId: "phase_d",
      status: "REJECTED",
    };
    const before = snapshot as WorkflowSnapshot;
    const next = applyActionResponse(before, response);

    // same reference returned - no allocation, no mutation
    expect(next).toBe(before);
    expect(next.phases.phase_d.status).toBe("BLOCKED");
  });
});

test.describe("Team B milestone 2 - live state sync", () => {
  test("sequential phase_updated events accumulate without cross-contamination", () => {
    // Simulates two parallel LLM phases completing back-to-back over SSE.
    const initial = snapshot as WorkflowSnapshot;

    const event1: PhaseUpdatedEvent = {
      eventId: "evt_seq_001",
      eventType: "phase_updated",
      runId: initial.runId,
      emittedAt: "2026-02-23T14:00:00Z",
      phase: { phaseId: "phase_b", attempt: 1, previousStatus: "RUNNING", status: "READY_FOR_REVIEW" },
    };
    const event2: PhaseUpdatedEvent = {
      eventId: "evt_seq_002",
      eventType: "phase_updated",
      runId: initial.runId,
      emittedAt: "2026-02-23T14:00:01Z",
      phase: { phaseId: "phase_c", attempt: 1, previousStatus: "RUNNING", status: "READY_FOR_REVIEW" },
    };

    const after1 = applyPhaseUpdatedEvent(initial, event1);
    const after2 = applyPhaseUpdatedEvent(after1, event2);

    // First event must not bleed into phase_c
    expect(after1.phases.phase_c.status).toBe("RUNNING");

    // Both phases updated in final state
    expect(after2.phases.phase_b.status).toBe("READY_FOR_REVIEW");
    expect(after2.phases.phase_c.status).toBe("READY_FOR_REVIEW");

    // Counts reflect final state - both in human queue
    const counts = computeWorkflowCounts(after2);
    expect(counts.running).toBe(0);
    expect(counts.humanQueue).toBe(2);

    // updatedAt tracks the latest event
    expect(after2.updatedAt).toBe(event2.emittedAt);
  });

  test("WAITING_FOR_HUMAN transition increments humanQueue", () => {
    // Simulates a human-review phase becoming active mid-stream.
    const initial = snapshot as WorkflowSnapshot;

    const event: PhaseUpdatedEvent = {
      eventId: "evt_wfh_001",
      eventType: "phase_updated",
      runId: initial.runId,
      emittedAt: "2026-02-23T14:01:00Z",
      phase: { phaseId: "phase_b", attempt: 1, previousStatus: "RUNNING", status: "WAITING_FOR_HUMAN" },
    };

    const after = applyPhaseUpdatedEvent(initial, event);
    const counts = computeWorkflowCounts(after);

    expect(counts.humanQueue).toBe(1);
    // phase_c is still RUNNING - should not be touched
    expect(counts.running).toBe(1);
    expect(after.phases.phase_c.status).toBe("RUNNING");
  });

  test("SSE data round-trip - JSON.parse then apply matches expected state", () => {
    // Simulates exactly what useWorkflowStream does: receive raw SSE data string,
    // JSON.parse it, and apply via applyPhaseUpdatedEvent.
    const sseData = JSON.stringify({
      eventId: "evt_roundtrip_001",
      eventType: "phase_updated",
      runId: "run_20260223_001",
      emittedAt: "2026-02-23T14:02:00Z",
      phase: { phaseId: "phase_b", attempt: 1, previousStatus: "RUNNING", status: "COMPLETED" },
    });

    const event = JSON.parse(sseData) as PhaseUpdatedEvent;
    const before = snapshot as WorkflowSnapshot;
    const after = applyPhaseUpdatedEvent(before, event);

    expect(after.phases.phase_b.status).toBe("COMPLETED");
    expect(after.updatedAt).toBe("2026-02-23T14:02:00Z");
    // heartbeat is a recognised SSE event type (frontend won't throw on it)
    expect(WORKFLOW_EVENT_TYPES).toContain("heartbeat");
  });
});

test.describe("Team B milestone 3 - action controls", () => {
  test("getAvailableActions maps every reviewable status to approve + reject", () => {
    expect(getAvailableActions("READY_FOR_REVIEW")).toEqual(["APPROVE_PHASE", "REJECT_PHASE"]);
    expect(getAvailableActions("WAITING_FOR_HUMAN")).toEqual(["APPROVE_PHASE", "REJECT_PHASE"]);
  });

  test("getAvailableActions maps non-reviewable statuses correctly", () => {
    expect(getAvailableActions("DRAFT")).toEqual(["START_PHASE"]);
    expect(getAvailableActions("ERROR_STATUS")).toEqual(["RETRY_PHASE"]);

    // Terminal / in-flight statuses have no human-actor actions
    for (const status of ["RUNNING", "BLOCKED", "APPROVED", "REJECTED", "COMPLETED"] as const) {
      expect(getAvailableActions(status)).toEqual([]);
    }
  });

  test("HUMAN phase in DRAFT is routed through context-init (START_PHASE available)", () => {
    // getAvailableActions must include START_PHASE for DRAFT so the form can
    // dispatch it. The page filters START_PHASE out of the button list for HUMAN
    // phases and replaces it with the ContextInitForm - this test proves the
    // action mapping that the form relies on is contract-stable.
    const actions = getAvailableActions("DRAFT");
    expect(actions).toContain("START_PHASE");
    expect(actions).not.toContain("APPROVE_PHASE");
    expect(actions).not.toContain("REJECT_PHASE");
  });

  test("context-init payload omits empty optional fields", () => {
    // Mirrors the ContextInitForm's payload-building logic: only non-empty fields
    // are included so the stored ContextArtifact JSON stays self-documenting.
    const intent = "Redesign onboarding modal to two-step flow";
    const tokens = "";  // user left blank
    const rubric = "WCAG 2.1 AA; matches design-system tokens";

    const payload: Record<string, unknown> = { intent };
    if (tokens.trim()) payload.tokens = tokens.trim();
    if (rubric.trim()) payload.rubric = rubric.trim();

    expect(payload.intent).toBe(intent);
    expect(payload.tokens).toBeUndefined();    // blank -> omitted
    expect(payload.rubric).toBe(rubric);

    const req = buildActionRequest("START_PHASE", "run_20260223_001", "phase_a", "user:ui", undefined, payload);
    expect(req.action).toBe("START_PHASE");
    expect(req.payload?.intent).toBeTruthy();
    expect(req.payload?.tokens).toBeUndefined();
  });

  test("buildActionRequest + resolveActionUrl produce a contract-compliant payload and URL", () => {
    const runId = "run_20260223_001";
    const phaseId = "phase_d";

    const req = buildActionRequest("APPROVE_PHASE", runId, phaseId, "user:ui", "LGTM");
    expect(req.action).toBe("APPROVE_PHASE");
    expect(req.runId).toBe(runId);
    expect(req.phaseId).toBe(phaseId);
    expect(req.actorId).toBe("user:ui");
    expect(req.reason).toBe("LGTM");
    // Optional fields omitted when not passed
    expect(buildActionRequest("START_PHASE", runId, phaseId, "user:ui").reason).toBeUndefined();
    expect(buildActionRequest("START_PHASE", runId, phaseId, "user:ui").payload).toBeUndefined();

    // URL expansion must match the real route path
    expect(resolveActionUrl("APPROVE_PHASE", runId, phaseId)).toBe(
      `/api/workflows/${runId}/phases/${phaseId}/approve`,
    );
    expect(resolveActionUrl("RETRY_PHASE", runId, phaseId)).toBe(
      `/api/workflows/${runId}/phases/${phaseId}/retry`,
    );
  });
});
