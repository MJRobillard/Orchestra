"use client";

import { useEffect } from "react";
import type { WorkflowSnapshot } from "@/contracts/workflow-contract";
import { useWorkflowStore } from "../store/workflow-store";

interface UseWorkflowSnapshotOptions {
  runId: string;
  /** Base URL of the backend API. Defaults to "" (same origin). */
  baseUrl?: string;
}

/**
 * Fetches the authoritative WorkflowSnapshot from the backend on mount
 * and writes it into the store, replacing the mock-seeded initial state.
 *
 * Fails silently when the backend is not running — the store keeps its
 * mock-JSON initial state, so the DAG still renders.
 */
export function useWorkflowSnapshot({ runId, baseUrl = "" }: UseWorkflowSnapshotOptions) {
  const setSnapshot = useWorkflowStore((s) => s.setSnapshot);

  useEffect(() => {
    let cancelled = false;

    fetch(`${baseUrl}/api/workflows/${runId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Snapshot fetch failed: HTTP ${r.status}`);
        return r.json() as Promise<WorkflowSnapshot>;
      })
      .then((data) => {
        if (!cancelled) setSnapshot(data);
      })
      .catch(() => {
        // Backend not running (M1) — keep mock snapshot from store init.
      });

    return () => {
      cancelled = true;
    };
  }, [runId, baseUrl, setSnapshot]);
}
