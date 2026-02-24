import { NextResponse } from "next/server";
import { getContractVersion, getWorkflowSnapshot } from "@/backend/workflow-engine";

interface RouteParams {
  params: Promise<{ runId: string }>;
}

export async function GET(_: Request, { params }: RouteParams) {
  const { runId } = await params;
  const snapshot = getWorkflowSnapshot(runId);

  return NextResponse.json(snapshot, {
    headers: {
      "x-contract-version": getContractVersion(),
    },
  });
}
