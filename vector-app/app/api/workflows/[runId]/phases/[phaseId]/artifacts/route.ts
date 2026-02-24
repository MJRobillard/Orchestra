import { NextResponse } from "next/server";
import { getContractVersion, getPhaseStoredArtifacts } from "@/backend/workflow-engine";

interface RouteParams {
  params: Promise<{ runId: string; phaseId: string }>;
}

export async function GET(_: Request, { params }: RouteParams) {
  const { runId, phaseId } = await params;
  const artifacts = getPhaseStoredArtifacts(runId, phaseId);

  return NextResponse.json(
    {
      runId,
      phaseId,
      artifacts,
    },
    { headers: { "x-contract-version": getContractVersion() } },
  );
}
