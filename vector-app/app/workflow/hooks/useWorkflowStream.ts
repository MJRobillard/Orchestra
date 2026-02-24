"use client";

import { useEffect } from "react";
import { ACTION_ENDPOINTS } from "@/contracts/workflow-contract";
import type { WorkflowEvent } from "@/contracts/workflow-contract";
import { useWorkflowStore } from "../store/workflow-store";

interface UseWorkflowStreamOptions {
  /** The workflow run ID to subscribe to. */
  runId: string;
  /**
   * Base URL of the backend API.  Defaults to "" (same origin).
   * Swap to the real FastAPI origin in M2 once the backend stream is live.
   */
  baseUrl?: string;
}

/**
 * Opens an EventSource connection to the backend SSE stream and dispatches
 * every incoming WorkflowEvent into the workflow store.
 *
 * Phase 1: hook is built but NOT called from page.tsx yet — no backend.
 * Phase 2: call this hook from WorkflowPage once the backend stream is live.
 *          Only `runId` (and optionally `baseUrl`) need to be passed in.
 *
 * The store's `connectionStatus` reflects open / connecting / closed / error
 * so the top bar can display a live connection indicator.
 */
export function useWorkflowStream({ runId, baseUrl = "" }: UseWorkflowStreamOptions) {
  const applyEvent = useWorkflowStore((s) => s.applyEvent);
  const setConnectionStatus = useWorkflowStore((s) => s.setConnectionStatus);

  useEffect(() => {
    const url = baseUrl + ACTION_ENDPOINTS.stream.replace(":runId", runId);

    setConnectionStatus("connecting");
    const source = new EventSource(url);

    source.onopen = () => setConnectionStatus("open");
    source.onerror = () => setConnectionStatus("error");

    // Generic `message` handler — covers backends that omit the `event:` field.
    source.onmessage = (e: MessageEvent<string>) => {
      try {
        applyEvent(JSON.parse(e.data) as WorkflowEvent);
      } catch {
        // malformed payload — discard silently
      }
    };

    // Named event handlers — covers backends that set `event: <type>` per SSE spec.
    const namedTypes: WorkflowEvent["eventType"][] = [
      "phase_updated",
      "heartbeat",
      "phase_output_ready",
      "workflow_completed",
      "workflow_failed",
    ];
    namedTypes.forEach((type) => {
      source.addEventListener(type, (e) => {
        try {
          applyEvent(JSON.parse((e as MessageEvent<string>).data) as WorkflowEvent);
        } catch {
          // malformed payload — discard silently
        }
      });
    });

    return () => {
      source.close();
      setConnectionStatus("closed");
    };
  }, [runId, baseUrl, applyEvent, setConnectionStatus]);
}
