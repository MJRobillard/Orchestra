import { NextResponse } from "next/server";
import { getContractVersion, resetWorkflowRun } from "@/backend/workflow-engine";

interface RouteParams {
  params: Promise<{ runId: string }>;
}

export async function POST(_: Request, { params }: RouteParams) {
  const { runId } = await params;
  const snapshot = resetWorkflowRun(runId);
  return NextResponse.json(snapshot, {
    headers: {
      "x-contract-version": getContractVersion(),
    },
  });
}
