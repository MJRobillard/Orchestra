import { handleActionRequest } from "@/backend/workflow-http";

interface RouteParams {
  params: Promise<{ runId: string; phaseId: string }>;
}

export async function POST(request: Request, context: RouteParams) {
  return handleActionRequest(request, context, "START_PHASE");
}
