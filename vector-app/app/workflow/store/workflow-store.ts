import { create } from "zustand";
import type {
  WorkflowActionResponse,
  WorkflowEvent,
  WorkflowSnapshot,
} from "@/contracts/workflow-contract";
import {
  applyPhaseUpdatedEvent,
  applyActionResponse as pureApplyActionResponse,
} from "@/contracts/workflow-state";
import snapshotJson from "@/mock_responses/workflow.snapshot.json";

// ── Connection status type (used by useWorkflowStream) ────────────────────
export type ConnectionStatus = "connecting" | "open" | "closed" | "error";

// ── Store shape ────────────────────────────────────────────────────────────
export interface WorkflowState {
  // State
  snapshot: WorkflowSnapshot;
  selectedPhaseId: string | null;
  connectionStatus: ConnectionStatus;
  lastEventId: string | undefined;

  // Actions
  setSnapshot: (snapshot: WorkflowSnapshot) => void;
  selectPhase: (phaseId: string | null) => void;
  applyEvent: (event: WorkflowEvent) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  applyActionResponse: (response: WorkflowActionResponse) => void;
}

// ── Store ──────────────────────────────────────────────────────────────────
// Initialised from the mock snapshot so the UI renders immediately on load.
// In M2+, `setSnapshot` will be called with the real API response before
// `useWorkflowStream` connects the live SSE feed.
export const useWorkflowStore = create<WorkflowState>()((set) => ({
  snapshot: snapshotJson as WorkflowSnapshot,
  selectedPhaseId: null,
  connectionStatus: "closed",
  lastEventId: undefined,

  setSnapshot: (snapshot) => set({ snapshot }),

  selectPhase: (phaseId) => set({ selectedPhaseId: phaseId }),

  applyEvent: (event) =>
    set((state) => {
      switch (event.eventType) {
        case "phase_updated":
          return {
            snapshot: applyPhaseUpdatedEvent(state.snapshot, event),
            lastEventId: event.eventId,
          };
        // heartbeat / phase_output_ready / workflow_completed / workflow_failed:
        // record the event ID; richer handling added per milestone.
        default:
          return { lastEventId: event.eventId };
      }
    }),

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),

  applyActionResponse: (response) =>
    set((state) => ({
      snapshot: pureApplyActionResponse(state.snapshot, response),
    })),
}));
