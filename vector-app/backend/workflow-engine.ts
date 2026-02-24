import snapshotTemplate from "@/mock_responses/workflow.snapshot.json";
import {
  CONTRACT_VERSION,
  type ArtifactRef,
  type PhaseOutput,
  type PhaseStatus,
  type WorkflowActionRequest,
  type WorkflowActionResponse,
  type WorkflowEvent,
  type WorkflowNode,
  type WorkflowSnapshot,
} from "@/contracts/workflow-contract";
import { publishWorkflowEvent } from "@/backend/workflow-events";
import {
  deleteRunData,
  getRunSnapshot,
  listArtifactsForPhase,
  saveArtifact,
  saveRunSnapshot,
} from "@/backend/workflow-db";

type MutableWorkflowSnapshot = WorkflowSnapshot;

const runs = new Map<string, MutableWorkflowSnapshot>();

interface ApplyActionResult {
  response: WorkflowActionResponse;
  event: WorkflowEvent;
}

const MUTATING_ACTIONS = new Set<WorkflowActionRequest["action"]>([
  "START_PHASE",
  "APPROVE_PHASE",
  "REJECT_PHASE",
  "RETRY_PHASE",
]);

const STATUS_TRANSITIONS: Record<WorkflowActionRequest["action"], PhaseStatus> = {
  START_PHASE: "RUNNING",
  APPROVE_PHASE: "APPROVED",
  REJECT_PHASE: "REJECTED",
  RETRY_PHASE: "RUNNING",
};

function cloneSnapshot(source: WorkflowSnapshot): MutableWorkflowSnapshot {
  return structuredClone(source);
}

function normalizePhaseAGate(snapshot: MutableWorkflowSnapshot): void {
  const phaseA = snapshot.phases["phase_a"];
  const phaseB = snapshot.phases["phase_b"];
  const phaseC = snapshot.phases["phase_c"];

  if (phaseA) {
    phaseA.status = "DRAFT";
    phaseA.startedAt = undefined;
    phaseA.finishedAt = undefined;
    phaseA.output = undefined;
    phaseA.error = undefined;
    phaseA.artifacts = [];
    phaseA.attempt = 1;
  }

  for (const phase of [phaseB, phaseC]) {
    if (!phase) continue;
    phase.status = "BLOCKED";
    phase.startedAt = undefined;
    phase.finishedAt = undefined;
    phase.output = undefined;
    phase.error = undefined;
    phase.artifacts = [];
    phase.attempt = 1;
  }

  for (const node of snapshot.nodes) {
    if (node.phaseId === "phase_a") node.status = "DRAFT";
    if (node.phaseId === "phase_b" || node.phaseId === "phase_c") node.status = "BLOCKED";
  }
}

function ensureRun(runId: string): MutableWorkflowSnapshot {
  const existing = runs.get(runId);
  if (existing) return existing;

  const persisted = getRunSnapshot(runId);
  if (persisted) {
    const hydrated = cloneSnapshot(persisted);
    runs.set(runId, hydrated);
    return hydrated;
  }

  const seeded = cloneSnapshot(snapshotTemplate as WorkflowSnapshot);
  seeded.runId = runId;
  seeded.createdAt = new Date().toISOString();
  seeded.updatedAt = seeded.createdAt;

  for (const phase of Object.values(seeded.phases)) {
    phase.runId = runId;
  }

  // Phase A is a hard gate in the product plan; new runs start at human context init.
  normalizePhaseAGate(seeded);

  runs.set(runId, seeded);
  saveRunSnapshot(seeded);
  return seeded;
}

function updateNodeStatus(nodes: WorkflowNode[], phaseId: string, status: PhaseStatus) {
  const node = nodes.find((candidate) => candidate.phaseId === phaseId);
  if (node) {
    node.status = status;
  }
}

function isDependencySatisfied(status: PhaseStatus): boolean {
  return status === "COMPLETED" || status === "APPROVED";
}

function unblockDependents(snapshot: MutableWorkflowSnapshot, updatedPhaseId: string) {
  for (const node of snapshot.nodes) {
    if (!node.dependsOn.includes(updatedPhaseId)) continue;
    if (node.status !== "BLOCKED") continue;

    const canRun = node.dependsOn.every((dependencyId) => {
      const dependencyPhase = snapshot.phases[dependencyId];
      return dependencyPhase ? isDependencySatisfied(dependencyPhase.status) : false;
    });

    if (canRun) {
      node.status = "DRAFT";
      const target = snapshot.phases[node.phaseId];
      if (target) {
        target.status = "DRAFT";
      }
    }
  }
}

export function getWorkflowSnapshot(runId: string): WorkflowSnapshot {
  return cloneSnapshot(ensureRun(runId));
}

export function getContractVersion(): string {
  return CONTRACT_VERSION;
}

export function applyWorkflowAction(request: WorkflowActionRequest): ApplyActionResult {
  if (!MUTATING_ACTIONS.has(request.action)) {
    throw new Error(`Unsupported action: ${request.action}`);
  }

  const snapshot = ensureRun(request.runId);
  const phase = snapshot.phases[request.phaseId];

  if (!phase) {
    throw new Error(`Unknown phaseId '${request.phaseId}' for run '${request.runId}'`);
  }

  const previousStatus = phase.status;
  const nextStatus = STATUS_TRANSITIONS[request.action];
  const nowIso = new Date().toISOString();

  phase.status = nextStatus;
  if (request.action === "START_PHASE" || request.action === "RETRY_PHASE") {
    phase.startedAt = nowIso;
  }
  if (request.action === "APPROVE_PHASE" || request.action === "REJECT_PHASE") {
    phase.finishedAt = nowIso;
  }
  if (request.action === "RETRY_PHASE") {
    phase.attempt += 1;
    phase.error = undefined;
    phase.output = undefined;
    phase.artifacts = [];
  }

  updateNodeStatus(snapshot.nodes, request.phaseId, nextStatus);
  snapshot.updatedAt = nowIso;
  unblockDependents(snapshot, request.phaseId);
  saveRunSnapshot(snapshot);

  const message = request.reason
    ? `${request.action} accepted by ${request.actorId}: ${request.reason}`
    : `${request.action} accepted by ${request.actorId}`;

  const event: WorkflowEvent = {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: "phase_updated",
    runId: request.runId,
    emittedAt: nowIso,
    phase: {
      phaseId: request.phaseId,
      attempt: phase.attempt,
      previousStatus,
      status: nextStatus,
    },
  };

  publishWorkflowEvent(event);

  return {
    response: {
      accepted: true,
      runId: request.runId,
      phaseId: request.phaseId,
      status: nextStatus,
      message,
    },
    event,
  };
}

export function persistPhaseOutput(params: {
  runId: string;
  phaseId: string;
  output: PhaseOutput;
  artifactPayloads: Array<{ kind: ArtifactRef["kind"]; data: unknown }>;
}): ArtifactRef[] {
  const snapshot = ensureRun(params.runId);
  const phase = snapshot.phases[params.phaseId];
  if (!phase) {
    throw new Error(`Unknown phaseId '${params.phaseId}' for run '${params.runId}'`);
  }

  const createdRefs: ArtifactRef[] = params.artifactPayloads.map((payload) => {
    const stored = saveArtifact({
      runId: params.runId,
      phaseId: params.phaseId,
      attempt: phase.attempt,
      kind: payload.kind,
      data: payload.data,
    });

    return {
      artifactId: stored.artifactId,
      kind: stored.kind,
      uri: stored.uri,
    };
  });

  phase.output = params.output;
  phase.artifacts = [
    ...phase.artifacts,
    ...createdRefs,
  ];
  snapshot.updatedAt = new Date().toISOString();
  saveRunSnapshot(snapshot);

  const event: WorkflowEvent = {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: "phase_output_ready",
    runId: params.runId,
    emittedAt: snapshot.updatedAt,
    phaseId: params.phaseId,
    artifacts: createdRefs,
  };
  publishWorkflowEvent(event);

  return createdRefs;
}

export function getPhaseStoredArtifacts(runId: string, phaseId: string) {
  const snapshot = ensureRun(runId);
  const phase = snapshot.phases[phaseId];
  if (!phase) return [];
  return listArtifactsForPhase(runId, phaseId, phase.attempt);
}

export function resetWorkflowEngineCache(): void {
  runs.clear();
}

export function resetWorkflowRun(runId: string): WorkflowSnapshot {
  runs.delete(runId);
  deleteRunData(runId);
  return getWorkflowSnapshot(runId);
}

export function markPhaseReadyForReview(params: {
  runId: string;
  phaseId: string;
  actorId: string;
}): ApplyActionResult {
  const snapshot = ensureRun(params.runId);
  const phase = snapshot.phases[params.phaseId];
  if (!phase) {
    throw new Error(`Unknown phaseId '${params.phaseId}' for run '${params.runId}'`);
  }
  const previousStatus = phase.status;
  const nowIso = new Date().toISOString();
  phase.status = "READY_FOR_REVIEW";
  phase.finishedAt = nowIso;
  updateNodeStatus(snapshot.nodes, params.phaseId, "READY_FOR_REVIEW");
  snapshot.updatedAt = nowIso;
  saveRunSnapshot(snapshot);

  const event: WorkflowEvent = {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: "phase_updated",
    runId: params.runId,
    emittedAt: nowIso,
    phase: {
      phaseId: params.phaseId,
      attempt: phase.attempt,
      previousStatus,
      status: "READY_FOR_REVIEW",
    },
  };
  publishWorkflowEvent(event);

  return {
    response: {
      accepted: true,
      runId: params.runId,
      phaseId: params.phaseId,
      status: "READY_FOR_REVIEW",
      message: `Phase moved to READY_FOR_REVIEW by ${params.actorId}`,
    },
    event,
  };
}

export function markPhaseCompleted(params: {
  runId: string;
  phaseId: string;
  actorId: string;
  reason?: string;
}): ApplyActionResult {
  const snapshot = ensureRun(params.runId);
  const phase = snapshot.phases[params.phaseId];
  if (!phase) {
    throw new Error(`Unknown phaseId '${params.phaseId}' for run '${params.runId}'`);
  }
  const previousStatus = phase.status;
  const nowIso = new Date().toISOString();
  phase.status = "COMPLETED";
  phase.finishedAt = nowIso;
  updateNodeStatus(snapshot.nodes, params.phaseId, "COMPLETED");
  snapshot.updatedAt = nowIso;
  unblockDependents(snapshot, params.phaseId);
  saveRunSnapshot(snapshot);

  const event: WorkflowEvent = {
    eventId: `evt_${crypto.randomUUID()}`,
    eventType: "phase_updated",
    runId: params.runId,
    emittedAt: nowIso,
    phase: {
      phaseId: params.phaseId,
      attempt: phase.attempt,
      previousStatus,
      status: "COMPLETED",
    },
  };
  publishWorkflowEvent(event);

  return {
    response: {
      accepted: true,
      runId: params.runId,
      phaseId: params.phaseId,
      status: "COMPLETED",
      message: params.reason
        ? `Phase completed by ${params.actorId}: ${params.reason}`
        : `Phase completed by ${params.actorId}`,
    },
    event,
  };
}
