import { NextResponse } from "next/server";

interface PythonBackendHealthPayload {
  enabled: boolean;
  connected: boolean;
  url?: string;
  status?: string;
  error?: string;
}

function isPythonBackendEnabled(env: NodeJS.ProcessEnv): boolean {
  const explicitToggle = env.PYTHON_BACKEND_ENABLED?.trim();
  if (explicitToggle) return explicitToggle === "1";
  return Boolean(env.PYTHON_BACKEND_URL?.trim());
}

function getPythonBackendUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env.PYTHON_BACKEND_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

export async function GET() {
  const enabled = isPythonBackendEnabled(process.env);
  const baseUrl = getPythonBackendUrl(process.env);

  if (!enabled || !baseUrl) {
    const payload: PythonBackendHealthPayload = {
      enabled: false,
      connected: false,
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const response = await fetch(`${baseUrl}/health`, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const payload: PythonBackendHealthPayload = {
        enabled: true,
        connected: false,
        url: baseUrl,
        error: `HTTP ${response.status}`,
      };
      return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
    }

    const body = (await response.json()) as { status?: string };
    const payload: PythonBackendHealthPayload = {
      enabled: true,
      connected: body.status === "ok",
      url: baseUrl,
      status: body.status,
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const payload: PythonBackendHealthPayload = {
      enabled: true,
      connected: false,
      url: baseUrl,
      error: error instanceof Error ? error.message : "Unknown health check failure",
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  }
}
