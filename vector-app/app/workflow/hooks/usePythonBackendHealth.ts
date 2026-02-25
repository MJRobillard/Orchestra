"use client";

import { useEffect, useState } from "react";

type PythonBackendStatus = "checking" | "connected" | "disconnected" | "disabled";

interface PythonBackendHealthResponse {
  enabled: boolean;
  connected: boolean;
}

export function usePythonBackendHealth(intervalMs: number = 5_000): PythonBackendStatus {
  const [status, setStatus] = useState<PythonBackendStatus>("checking");

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const response = await fetch("/api/python-backend/health", {
          method: "GET",
          cache: "no-store",
        });
        if (!response.ok) {
          if (!cancelled) setStatus("disconnected");
          return;
        }
        const payload = (await response.json()) as PythonBackendHealthResponse;
        if (cancelled) return;
        if (!payload.enabled) {
          setStatus("disabled");
          return;
        }
        setStatus(payload.connected ? "connected" : "disconnected");
      } catch {
        if (!cancelled) setStatus("disconnected");
      }
    }

    void probe();
    const timer = setInterval(() => {
      void probe();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return status;
}
