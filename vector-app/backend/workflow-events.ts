import type { HeartbeatEvent, WorkflowEvent } from "@/contracts/workflow-contract";

type RunEventListener = (event: WorkflowEvent) => void;

const runListeners = new Map<string, Set<RunEventListener>>();

export function subscribeToRunEvents(runId: string, listener: RunEventListener): () => void {
  const listeners = runListeners.get(runId) ?? new Set<RunEventListener>();
  listeners.add(listener);
  runListeners.set(runId, listeners);

  return () => {
    const current = runListeners.get(runId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      runListeners.delete(runId);
    }
  };
}

export function publishWorkflowEvent(event: WorkflowEvent): void {
  const listeners = runListeners.get(event.runId);
  if (!listeners || listeners.size === 0) return;

  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      // Listener faults should never break backend state progression.
      console.error("workflow event listener failed", error);
    }
  }
}

export function createHeartbeatEvent(runId: string, sequence: number): HeartbeatEvent {
  return {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: "heartbeat",
    runId,
    emittedAt: new Date().toISOString(),
    sequence,
  };
}
