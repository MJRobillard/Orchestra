import {
  ACTION_ENDPOINTS,
  type PhaseStatus,
  type WorkflowActionRequest,
  type WorkflowActionType,
} from "@/contracts/workflow-contract";

// ── Which actions are available per phase status ────────────────────────────
//
// Design note (Issue 3 — low priority):
// START_PHASE and RETRY_PHASE are intentionally included here alongside the
// human-review actions (APPROVE / REJECT). The review panel is the single
// operator surface in this UI; a separate "operator panel" is deferred to M4+.
// If responsibilities need to be separated, split this map into
// HUMAN_REVIEW_ACTIONS and OPERATOR_ACTIONS and render them in distinct sections.

const ACTIONS_BY_STATUS: Partial<Record<PhaseStatus, WorkflowActionType[]>> = {
  DRAFT:              ["START_PHASE"],
  READY_FOR_REVIEW:   ["APPROVE_PHASE", "REJECT_PHASE"],
  WAITING_FOR_HUMAN:  ["APPROVE_PHASE", "REJECT_PHASE"],
  ERROR_STATUS:       ["RETRY_PHASE"],
};

/** Returns the list of actions a human actor can take for a given phase status. */
export function getAvailableActions(status: PhaseStatus): WorkflowActionType[] {
  return ACTIONS_BY_STATUS[status] ?? [];
}

// ── URL resolution ──────────────────────────────────────────────────────────

const ACTION_ENDPOINT_KEY: Record<WorkflowActionType, keyof typeof ACTION_ENDPOINTS> = {
  START_PHASE:   "start",
  APPROVE_PHASE: "approve",
  REJECT_PHASE:  "reject",
  RETRY_PHASE:   "retry",
};

/** Expands an ACTION_ENDPOINTS template for a concrete run + phase. */
export function resolveActionUrl(
  action: WorkflowActionType,
  runId: string,
  phaseId: string,
): string {
  const template = ACTION_ENDPOINTS[ACTION_ENDPOINT_KEY[action]];
  return (template as string)
    .replace(":runId", runId)
    .replace(":phaseId", phaseId);
}

// ── Request factory ─────────────────────────────────────────────────────────

/** Constructs a contract-compliant WorkflowActionRequest. */
export function buildActionRequest(
  action: WorkflowActionType,
  runId: string,
  phaseId: string,
  actorId: string,
  reason?: string,
  payload?: Record<string, unknown>,
): WorkflowActionRequest {
  const req: WorkflowActionRequest = { action, runId, phaseId, actorId };
  if (reason) req.reason = reason;
  if (payload) req.payload = payload;
  return req;
}

// ── UI metadata ─────────────────────────────────────────────────────────────

export const ACTION_LABEL: Record<WorkflowActionType, string> = {
  START_PHASE:   "Start",
  APPROVE_PHASE: "Approve",
  REJECT_PHASE:  "Reject",
  RETRY_PHASE:   "Retry",
};

export const ACTION_BUTTON_CLASS: Record<WorkflowActionType, string> = {
  START_PHASE:   "bg-blue-600 hover:bg-blue-500 focus-visible:ring-blue-500",
  APPROVE_PHASE: "bg-emerald-600 hover:bg-emerald-500 focus-visible:ring-emerald-500",
  REJECT_PHASE:  "bg-red-700 hover:bg-red-600 focus-visible:ring-red-500",
  RETRY_PHASE:   "bg-amber-600 hover:bg-amber-500 focus-visible:ring-amber-500",
};
