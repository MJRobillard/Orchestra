import type { PreviewCodeArtifact, PreviewRenderMode, PreviewSchemaRoot } from "@/contracts/preview-schema";

export const PHASE_STATUSES = [
  "DRAFT",
  "BLOCKED",
  "RUNNING",
  "WAITING_FOR_HUMAN",
  "READY_FOR_REVIEW",
  "APPROVED",
  "REJECTED",
  "ERROR_STATUS",
  "COMPLETED",
] as const;

export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export type PhaseType = "SYSTEM" | "LLM" | "HUMAN";

export interface WorkflowNode {
  phaseId: string;
  label: string;
  phaseType: PhaseType;
  status: PhaseStatus;
  dependsOn: string[];
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface ArtifactRef {
  artifactId: string;
  kind: "diff" | "rubric" | "patch" | "log" | "json";
  uri: string;
}

export interface PhaseOutput {
  variantId?: string;
  renderMode?: PreviewRenderMode;
  uiSchema?: PreviewSchemaRoot;
  uiCode?: PreviewCodeArtifact;
  diff?: string;
  rubricResults?: Array<{
    criterion: string;
    score: number;
    maxScore: number;
    note?: string;
  }>;
  details?: Record<string, unknown>;
}

export interface PhaseSnapshot {
  runId: string;
  phaseId: string;
  attempt: number;
  status: PhaseStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  output?: PhaseOutput;
  artifacts: ArtifactRef[];
}

export interface WorkflowSnapshot {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  createdAt: string;
  updatedAt: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  phases: Record<string, PhaseSnapshot>;
}

export type WorkflowActionType = "START_PHASE" | "APPROVE_PHASE" | "REJECT_PHASE" | "RETRY_PHASE";

export interface WorkflowActionRequest {
  action: WorkflowActionType;
  runId: string;
  phaseId: string;
  actorId: string;
  reason?: string;
  payload?: Record<string, unknown>;
}

export interface WorkflowActionResponse {
  accepted: boolean;
  runId: string;
  phaseId: string;
  status: PhaseStatus;
  message?: string;
}

export const WORKFLOW_EVENT_TYPES = [
  "heartbeat",
  "phase_updated",
  "phase_output_ready",
  "workflow_completed",
  "workflow_failed",
] as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

export interface WorkflowEventBase {
  eventId: string;
  eventType: WorkflowEventType;
  runId: string;
  emittedAt: string;
}

export interface PhaseUpdatedEvent extends WorkflowEventBase {
  eventType: "phase_updated";
  phase: {
    phaseId: string;
    attempt: number;
    previousStatus: PhaseStatus;
    status: PhaseStatus;
    error?: string;
  };
}

export interface HeartbeatEvent extends WorkflowEventBase {
  eventType: "heartbeat";
  sequence: number;
}

export interface PhaseOutputReadyEvent extends WorkflowEventBase {
  eventType: "phase_output_ready";
  phaseId: string;
  artifacts: ArtifactRef[];
}

export interface WorkflowCompletedEvent extends WorkflowEventBase {
  eventType: "workflow_completed";
  finalStatus: "COMPLETED";
}

export interface WorkflowFailedEvent extends WorkflowEventBase {
  eventType: "workflow_failed";
  finalStatus: "ERROR_STATUS";
  error: string;
}

export type WorkflowEvent =
  | HeartbeatEvent
  | PhaseUpdatedEvent
  | PhaseOutputReadyEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent;

export const ACTION_ENDPOINTS = {
  start: "/api/workflows/:runId/phases/:phaseId/start",
  approve: "/api/workflows/:runId/phases/:phaseId/approve",
  reject: "/api/workflows/:runId/phases/:phaseId/reject",
  retry: "/api/workflows/:runId/phases/:phaseId/retry",
  stream: "/api/workflows/:runId/stream",
} as const;

export const CONTRACT_VERSION = "2026-02-23.v1";
