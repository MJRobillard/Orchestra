"use client";

import { useCallback, useState } from "react";
import type { WorkflowActionResponse, WorkflowActionType } from "@/contracts/workflow-contract";
import type { WorkflowSnapshot } from "@/contracts/workflow-contract";
import { buildActionRequest, resolveActionUrl } from "../utils/workflow-actions";
import { useWorkflowStore } from "../store/workflow-store";

interface UsePhaseActionOptions {
  runId: string;
  phaseId: string;
  /** Identifies the human actor in the action log. Defaults to "user:ui". */
  actorId?: string;
}

interface UsePhaseActionResult {
  loading: boolean;
  loadingAction: WorkflowActionType | null;
  error: string | null;
  /** Dispatch an action and synchronise the store on success. */
  dispatch: (
    action: WorkflowActionType,
    reason?: string,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}

function readConfiguredBranchFactor(snapshot: WorkflowSnapshot): number | undefined {
  const details = snapshot.phases.phase_a?.output?.details;
  if (!details || typeof details !== "object") return undefined;
  const contextArtifact = (details as Record<string, unknown>).contextArtifact;
  if (!contextArtifact || typeof contextArtifact !== "object") return undefined;
  const branchFactor = (contextArtifact as Record<string, unknown>).branchFactor;
  return typeof branchFactor === "number" ? branchFactor : undefined;
}

/**
 * Sends an action to the backend action endpoint, then applies the response
 * to the Zustand store so the DAG and detail panel stay in sync.
 *
 * Failures are surface-local (written to `error`) — they never throw.
 */
export function usePhaseAction({
  runId,
  phaseId,
  actorId = "user:ui",
}: UsePhaseActionOptions): UsePhaseActionResult {
  const [loading, setLoading] = useState(false);
  const [loadingAction, setLoadingAction] = useState<WorkflowActionType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const applyActionResponse = useWorkflowStore((s) => s.applyActionResponse);
  const setSnapshot = useWorkflowStore((s) => s.setSnapshot);
  const snapshot = useWorkflowStore((s) => s.snapshot);

  const dispatch = useCallback(
    async (
      action: WorkflowActionType,
      reason?: string,
      payload?: Record<string, unknown>,
    ) => {
      setLoading(true);
      setLoadingAction(action);
      setError(null);

      const targetPhase = snapshot.phases[phaseId];
      if (action === "START_PHASE" && targetPhase && targetPhase.status !== "RUNNING") {
        setSnapshot({
          ...snapshot,
          phases: {
            ...snapshot.phases,
            [phaseId]: {
              ...targetPhase,
              status: "RUNNING",
              startedAt: targetPhase.startedAt ?? new Date().toISOString(),
              error: undefined,
            },
          },
        });
      }

      if (
        phaseId === "phase_e"
        && action === "RETRY_PHASE"
        && typeof payload?.refinementPrompt === "string"
      ) {
        const configuredBranchFactor = readConfiguredBranchFactor(snapshot);
        const branchFactor = typeof configuredBranchFactor === "number"
          ? Math.min(8, Math.max(2, Math.round(configuredBranchFactor)))
          : 2;
        const generatedRefinements = Array.from({ length: branchFactor }, (_, index) => ({
          variantId: `phase_e_induction_${index + 1}`,
          label: `Induction Variant ${index + 1}`,
          status: "RUNNING",
        }));
        setSnapshot({
          ...snapshot,
          phases: {
            ...snapshot.phases,
            phase_e: {
              ...snapshot.phases.phase_e,
              output: {
                ...(snapshot.phases.phase_e.output ?? {}),
                details: {
                  ...(snapshot.phases.phase_e.output?.details ?? {}),
                  source: "phase_e_component_induction_pending",
                  componentSelector:
                    typeof payload.componentSelector === "string" && payload.componentSelector.trim().length > 0
                      ? payload.componentSelector
                      : undefined,
                  refinementPrompt: payload.refinementPrompt,
                  selectionMode:
                    typeof payload.componentSelector === "string" && payload.componentSelector.trim().length > 0
                      ? "explicit_selector"
                      : "auto_infer",
                  generatedRefinements,
                },
              },
            },
          },
        });
      }

      try {
        const url = resolveActionUrl(action, runId, phaseId);
        const body = buildActionRequest(action, runId, phaseId, actorId, reason, payload);

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = (await res.json()) as WorkflowActionResponse;

        if (!res.ok || !data.accepted) {
          setError(data.message ?? `${action} was rejected by the server`);
          return;
        }

        // Optimistic update: immediately reflect the targeted phase change.
        applyActionResponse(data);

        // Reconcile: the backend may have silently unblocked downstream phases
        // via `unblockDependents` without emitting individual SSE events for each.
        // A background re-fetch replaces the whole snapshot with the authoritative
        // state, so dependent node colours are never stale.
        fetch(`/api/workflows/${runId}`)
          .then((r) => (r.ok ? (r.json() as Promise<WorkflowSnapshot>) : null))
          .then((fresh) => { if (fresh) setSnapshot(fresh); })
          .catch(() => {/* silent — optimistic state is still correct for the targeted phase */});
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        setLoading(false);
        setLoadingAction(null);
      }
    },
    [runId, phaseId, actorId, applyActionResponse, setSnapshot, snapshot],
  );

  return { loading, loadingAction, error, dispatch };
}
