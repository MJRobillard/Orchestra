import type {
  PhaseUpdatedEvent,
  WorkflowActionResponse,
  WorkflowSnapshot,
} from "@/contracts/workflow-contract";

export interface WorkflowCounts {
  total: number;
  running: number;
  humanQueue: number;
}

// ── Pure transition functions ──────────────────────────────────────────────
// All state mutations live here so both teams' tests can import and
// validate the same logic without touching any React or Zustand code.

export function applyPhaseUpdatedEvent(
  snapshot: WorkflowSnapshot,
  event: PhaseUpdatedEvent,
): WorkflowSnapshot {
  const next = structuredClone(snapshot);

  const targetNode = next.nodes.find((node) => node.phaseId === event.phase.phaseId);
  if (targetNode) {
    targetNode.status = event.phase.status;
  }

  const targetPhase = next.phases[event.phase.phaseId];
  if (targetPhase) {
    targetPhase.status = event.phase.status;
  }

  next.updatedAt = event.emittedAt;
  return next;
}

/**
 * Applies an accepted WorkflowActionResponse (approve/reject/retry/start) to
 * the snapshot.  Returns the original snapshot unchanged when `accepted` is
 * false so callers can use referential equality as a change guard.
 */
export function applyActionResponse(
  snapshot: WorkflowSnapshot,
  response: WorkflowActionResponse,
): WorkflowSnapshot {
  if (!response.accepted) return snapshot;

  const next = structuredClone(snapshot);

  const targetNode = next.nodes.find((n) => n.phaseId === response.phaseId);
  if (targetNode) targetNode.status = response.status;

  const targetPhase = next.phases[response.phaseId];
  if (targetPhase) targetPhase.status = response.status;

  return next;
}

export function computeWorkflowCounts(snapshot: WorkflowSnapshot): WorkflowCounts {
  return snapshot.nodes.reduce(
    (acc, node) => {
      acc.total += 1;
      if (node.status === "RUNNING") acc.running += 1;
      if (node.status === "WAITING_FOR_HUMAN" || node.status === "READY_FOR_REVIEW")
        acc.humanQueue += 1;
      return acc;
    },
    { total: 0, running: 0, humanQueue: 0 },
  );
}
