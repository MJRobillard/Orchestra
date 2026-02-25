"use client";

import dynamic from "next/dynamic";
import phaseUpdatedJson from "@/mock_responses/sse.phase_updated.json";
import { computeWorkflowCounts } from "@/contracts/workflow-state";
import type { PhaseSnapshot, PhaseUpdatedEvent, PhaseStatus, WorkflowSnapshot } from "@/contracts/workflow-contract";
import { PHASE_STATUSES } from "@/contracts/workflow-contract";
import { useWorkflowStore, type ConnectionStatus } from "./store/workflow-store";
import { useWorkflowSnapshot } from "./hooks/useWorkflowSnapshot";
import { useWorkflowStream } from "./hooks/useWorkflowStream";
import { usePhaseAction } from "./hooks/usePhaseAction";
import { usePythonBackendHealth } from "./hooks/usePythonBackendHealth";
import {
  ACTION_BUTTON_CLASS,
  ACTION_LABEL,
  getAvailableActions,
} from "./utils/workflow-actions";
import { ContextInitForm } from "./components/ContextInitForm";
import { MergeReviewForm } from "./components/MergeReviewForm";
import { ComponentInductionForm } from "./components/ComponentInductionForm";
import { InductionMergeForm } from "./components/InductionMergeForm";
import { PhaseAProofCard } from "./components/PhaseAProofCard";
import { StrictSandboxCodePreview } from "./components/StrictSandboxCodePreview";
import { schemaToSafeHtml } from "./utils/schema-to-safe-html";
import { useMemo, useState } from "react";
import type { WorkflowActionType } from "@/contracts/workflow-contract";
import type { PreviewCodeArtifact } from "@/contracts/preview-schema";
import type { PhaseOutput } from "@/contracts/workflow-contract";

// ReactFlow requires browser APIs — must not SSR
const WorkflowDAG = dynamic(
  () => import("./components/WorkflowDAG").then((m) => m.WorkflowDAG),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 px-4 py-3 text-xs text-slate-300">
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-400" />
            Preparing workflow graph...
          </span>
        </div>
      </div>
    ),
  },
);

// ── Status colour map (reused in right panel) ──────────────────────────────
const STATUS_COLOR: Record<PhaseStatus, string> = {
  DRAFT: "text-slate-400",
  BLOCKED: "text-slate-500",
  RUNNING: "text-blue-400",
  WAITING_FOR_HUMAN: "text-amber-400",
  READY_FOR_REVIEW: "text-orange-400",
  APPROVED: "text-emerald-400",
  REJECTED: "text-red-400",
  ERROR_STATUS: "text-red-300",
  COMPLETED: "text-emerald-500",
};

const CONNECTION_INDICATOR: Record<ConnectionStatus, { dot: string; label: string }> = {
  connecting: { dot: "bg-amber-400 animate-pulse", label: "connecting…" },
  open:        { dot: "bg-emerald-400",             label: "live"        },
  closed:      { dot: "bg-slate-600",               label: "offline"     },
  error:       { dot: "bg-red-500",                 label: "error"       },
};

const PYTHON_BACKEND_INDICATOR: Record<
  ReturnType<typeof usePythonBackendHealth>,
  { dot: string; label: string }
> = {
  checking: { dot: "bg-amber-400 animate-pulse", label: "Backend: checking" },
  connected: { dot: "bg-emerald-400", label: "Backend: connected" },
  disconnected: { dot: "bg-red-500", label: "Backend: disconnected" },
  disabled: { dot: "bg-slate-600", label: "Backend: disabled" },
};

const WORKFLOW_RUN_ID = "run_phase_a_poc";
const INDUCTION_MERGE_NODE_ID = "phase_e_induction_merge";

function looksLikeHtmlSnippet(raw: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(raw);
}

function sanitizeGeneratedHtml(raw: string): { sanitized: string; changed: boolean; safe: boolean } {
  const original = raw;
  let sanitized = raw.trim();

  if (!sanitized) return { sanitized: "", changed: original !== sanitized, safe: false };

  sanitized = sanitized.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
  sanitized = sanitized.replace(/<(iframe|object|embed)\b[\s\S]*?>[\s\S]*?<\/\1>/gi, "");
  sanitized = sanitized.replace(/<(iframe|object|embed)\b[^>]*\/?>/gi, "");
  sanitized = sanitized.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  sanitized = sanitized.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  sanitized = sanitized.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  sanitized = sanitized.replace(/\s(href|src)\s*=\s*"javascript:[^"]*"/gi, "");
  sanitized = sanitized.replace(/\s(href|src)\s*=\s*'javascript:[^']*'/gi, "");
  sanitized = sanitized.replace(/url\s*\(\s*(['"]?)javascript:[^)]*\1\s*\)/gi, "none");

  const hasHardBlockedTokens =
    /<script\b/i.test(sanitized) ||
    /<(iframe|object|embed)\b/i.test(sanitized) ||
    /\son[a-z]+\s*=/i.test(sanitized) ||
    /javascript:/i.test(sanitized);

  return {
    sanitized,
    changed: sanitized !== original,
    safe: sanitized.length > 0 && !hasHardBlockedTokens,
  };
}

function extractJsonObjectBalanced(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) startIndex = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        return candidate.slice(startIndex, i + 1);
      }
    }
  }

  return "";
}

function parseCodeArtifact(candidate: unknown): PreviewCodeArtifact | null {
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;
  if (record.language !== "html" || typeof record.code !== "string") return null;
  if (!looksLikeHtmlSnippet(record.code)) return null;
  const cleaned = sanitizeGeneratedHtml(record.code);
  if (!cleaned.safe) return null;
  return {
    language: "html",
    code: cleaned.sanitized,
    sanitized: cleaned.changed,
  };
}

function parseStructuredFromRaw(raw?: string): { uiCode?: PreviewCodeArtifact; uiSchema?: unknown } | null {
  if (!raw || typeof raw !== "string") return null;
  const jsonText = extractJsonObjectBalanced(raw);
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText) as {
      uiCode?: unknown;
      uiSchema?: unknown;
    };
    return {
      uiCode: parseCodeArtifact(parsed.uiCode) ?? undefined,
      uiSchema: parsed.uiSchema,
    };
  } catch {
    return null;
  }
}

function getConceptOneLiner(diff?: string): string {
  if (!diff) return "A refined UI concept is ready for visual review.";
  const firstLine = diff.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  if (!firstLine) return "A refined UI concept is ready for visual review.";
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine;
}

function getRenderableArtifact(output?: PhaseOutput): PreviewCodeArtifact | null {
  if (!output) return null;
  const parsedCode = parseCodeArtifact(output.uiCode);
  if (parsedCode) {
    return parsedCode;
  }

  const recovered = parseStructuredFromRaw(
    typeof output.details?.rawLlmResponse === "string" ? output.details.rawLlmResponse : undefined,
  );
  const recoveredCode = recovered?.uiCode;
  if (recoveredCode) return recoveredCode;

  if (!output.uiSchema) return null;
  return {
    language: "html",
    code: schemaToSafeHtml(output.uiSchema as Parameters<typeof schemaToSafeHtml>[0]),
    sanitized: true,
  };
}

function getVariantNodeId(index: number, total: number): string {
  if (index === 0) return "phase_b";
  if (index === total - 1) return "phase_c";
  return `phase_variant_${index + 1}`;
}

function readConfiguredBranchFactor(snapshot: WorkflowSnapshot): number | undefined {
  const details = snapshot.phases.phase_a?.output?.details;
  if (!details || typeof details !== "object") return undefined;
  const contextArtifact = (details as Record<string, unknown>).contextArtifact;
  if (!contextArtifact || typeof contextArtifact !== "object") return undefined;
  const branchFactor = (contextArtifact as Record<string, unknown>).branchFactor;
  return typeof branchFactor === "number" ? branchFactor : undefined;
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function WorkflowPage() {
  // ── Store subscriptions ────────────────────────────────────────────────
  const snapshot         = useWorkflowStore((s) => s.snapshot);
  const selectedPhaseId  = useWorkflowStore((s) => s.selectedPhaseId);
  const connectionStatus = useWorkflowStore((s) => s.connectionStatus);
  const selectPhase      = useWorkflowStore((s) => s.selectPhase);
  const applyEvent       = useWorkflowStore((s) => s.applyEvent);
  const setSnapshot      = useWorkflowStore((s) => s.setSnapshot);

  // M2: Hydrate store from backend API, then open SSE stream.
  // Both hooks fail silently — store keeps mock state if backend is offline.
  useWorkflowSnapshot({ runId: WORKFLOW_RUN_ID });
  useWorkflowStream({ runId: WORKFLOW_RUN_ID });

  // M3: Action dispatch for the selected phase.
  const actionPhaseId =
    selectedPhaseId === INDUCTION_MERGE_NODE_ID
      ? "phase_e"
      : (selectedPhaseId ?? "");
  const phaseAction = usePhaseAction({
    runId: WORKFLOW_RUN_ID,
    phaseId: actionPhaseId,
  });

  // ── Derived ───────────────────────────────────────────────────────────
  const [branchFactor, setBranchFactor] = useState<number>(2);
  const configuredBranchFactor = readConfiguredBranchFactor(snapshot);
  const lockedBranchFactor =
    typeof configuredBranchFactor === "number"
      ? Math.min(8, Math.max(2, Math.round(configuredBranchFactor)))
      : branchFactor;
  const isBranchFactorLocked = snapshot.nodes.some(
    (node) => node.status !== "DRAFT" && node.status !== "BLOCKED",
  );
  const effectiveBranchFactor = isBranchFactorLocked ? lockedBranchFactor : branchFactor;

  const renderingSnapshot = useMemo((): WorkflowSnapshot => {
    const factor = Math.min(8, Math.max(2, Math.round(effectiveBranchFactor)));
    const next = structuredClone(snapshot);
    const generatedById = new Map<string, Record<string, unknown>>();
    const rawGenerated = next.phases.phase_d?.output?.details?.generatedVariants;
    const hasGeneratedVariants = Array.isArray(rawGenerated) && rawGenerated.length > 0;
    const phaseAStatus = next.phases.phase_a?.status;
    const hasPhaseAStarted = phaseAStatus !== "DRAFT" && phaseAStatus !== "BLOCKED";
    const shouldOptimisticallyShowVariantsRunning = hasPhaseAStarted && !hasGeneratedVariants;
    if (Array.isArray(rawGenerated)) {
      for (const variant of rawGenerated) {
        if (!variant || typeof variant !== "object") continue;
        const candidate = variant as Record<string, unknown>;
        const variantId = typeof candidate.variantId === "string" ? candidate.variantId : undefined;
        if (!variantId) continue;
        generatedById.set(variantId, candidate);
      }
    }

    if (shouldOptimisticallyShowVariantsRunning) {
      next.nodes = next.nodes.map((node) => {
        if ((node.phaseId === "phase_b" || node.phaseId === "phase_c")
          && (node.status === "DRAFT" || node.status === "BLOCKED")) {
          return {
            ...node,
            status: "RUNNING",
          };
        }
        return node;
      });
    }

    for (let index = 0; index < factor; index += 1) {
      const phaseId = getVariantNodeId(index, factor);
      if (phaseId === "phase_b" || phaseId === "phase_c") continue;
      const variantData = generatedById.get(phaseId);
      const variantLabel = variantData?.label;
      const variantStatus = variantData?.status;
      const status: PhaseStatus =
        typeof variantStatus === "string" && PHASE_STATUSES.includes(variantStatus as PhaseStatus)
          ? (variantStatus as PhaseStatus)
          : generatedById.has(phaseId)
            ? "APPROVED"
            : shouldOptimisticallyShowVariantsRunning
              ? "RUNNING"
              : "BLOCKED";

      next.nodes.push({
        phaseId,
        label: typeof variantLabel === "string" ? variantLabel : `Variant Generation ${index + 1}`,
        phaseType: "LLM",
        status,
        dependsOn: ["phase_a"],
      });
      next.edges.push({ from: "phase_a", to: phaseId });
      next.edges.push({ from: phaseId, to: "phase_d" });
    }

    const rawRefinements = next.phases.phase_e?.output?.details?.generatedRefinements;
    if (Array.isArray(rawRefinements)) {
      const refinementPhaseIds: string[] = [];
      for (let index = 0; index < rawRefinements.length; index += 1) {
        const entry = rawRefinements[index];
        if (!entry || typeof entry !== "object") continue;
        const candidate = entry as Record<string, unknown>;
        const phaseId = typeof candidate.variantId === "string" ? candidate.variantId : undefined;
        if (!phaseId) continue;
        refinementPhaseIds.push(phaseId);
        const label = typeof candidate.label === "string" ? candidate.label : `Induction Variant ${index + 1}`;
        const candidateStatus = typeof candidate.status === "string" ? candidate.status : undefined;
        const status: PhaseStatus =
          candidateStatus && PHASE_STATUSES.includes(candidateStatus as PhaseStatus)
            ? (candidateStatus as PhaseStatus)
            : "RUNNING";
        if (!next.nodes.some((node) => node.phaseId === phaseId)) {
          next.nodes.push({
            phaseId,
            label,
            phaseType: "LLM",
            status,
            dependsOn: ["phase_e"],
          });
        }
        if (!next.edges.some((edge) => edge.from === "phase_e" && edge.to === phaseId)) {
          next.edges.push({ from: "phase_e", to: phaseId });
        }
      }
    }

    const refinementPhaseIds = Array.isArray(rawRefinements)
      ? rawRefinements
          .map((entry) => {
            if (!entry || typeof entry !== "object") return null;
            const candidate = entry as Record<string, unknown>;
            return typeof candidate.variantId === "string" ? candidate.variantId : null;
          })
          .filter((id): id is string => Boolean(id))
      : [];
    const hasRefinementBranches = refinementPhaseIds.length > 0;
    const allRefinementsTerminal =
      hasRefinementBranches && refinementPhaseIds.every((phaseId) => {
        const node = next.nodes.find((candidate) => candidate.phaseId === phaseId);
        const status = node?.status ?? "RUNNING";
        return status !== "RUNNING" && status !== "DRAFT" && status !== "BLOCKED";
      });
    const mergedAt =
      (next.phases.phase_e?.output?.details as Record<string, unknown> | undefined)?.inductionMerge &&
      typeof (next.phases.phase_e?.output?.details as Record<string, unknown>)?.inductionMerge === "object"
        ? (next.phases.phase_e?.output?.details as Record<string, unknown>).inductionMerge as Record<string, unknown>
        : undefined;
    if (hasRefinementBranches) {
      const mergeStatus: PhaseStatus =
        mergedAt && typeof mergedAt.mergedAt === "string"
          ? "COMPLETED"
          : allRefinementsTerminal
            ? "DRAFT"
            : "BLOCKED";
      next.nodes = next.nodes.filter((node) => node.phaseId !== INDUCTION_MERGE_NODE_ID);
      next.nodes.push({
        phaseId: INDUCTION_MERGE_NODE_ID,
        label: "Induction Merger",
        phaseType: "HUMAN",
        status: mergeStatus,
        dependsOn: refinementPhaseIds,
      });
      for (const dependencyId of refinementPhaseIds) {
        if (!next.edges.some((edge) => edge.from === dependencyId && edge.to === INDUCTION_MERGE_NODE_ID)) {
          next.edges.push({ from: dependencyId, to: INDUCTION_MERGE_NODE_ID });
        }
      }
    }

    return next;
  }, [snapshot, effectiveBranchFactor]);

  const variantSyntheticPhaseById = useMemo(() => {
    const map = new Map<string, PhaseSnapshot>();
    const generatedById = new Map<string, { output?: PhaseSnapshot["output"]; status?: PhaseStatus }>();
    const rawGenerated = snapshot.phases.phase_d?.output?.details?.generatedVariants;
    if (Array.isArray(rawGenerated)) {
      for (const variant of rawGenerated) {
        if (!variant || typeof variant !== "object") continue;
        const candidate = variant as Record<string, unknown>;
        const variantId = typeof candidate.variantId === "string" ? candidate.variantId : undefined;
        const output = candidate.output;
        if (!variantId) continue;
        const status = typeof candidate.status === "string" && PHASE_STATUSES.includes(candidate.status as PhaseStatus)
          ? (candidate.status as PhaseStatus)
          : undefined;
        generatedById.set(variantId, {
          output: output && typeof output === "object" ? (output as PhaseSnapshot["output"]) : undefined,
          status,
        });
      }
    }

    const syntheticNodes = renderingSnapshot.nodes.filter((node) => node.phaseId.startsWith("phase_variant_"));
    for (const node of syntheticNodes) {
      map.set(node.phaseId, {
        runId: snapshot.runId,
        phaseId: node.phaseId,
        attempt: 1,
        status: generatedById.get(node.phaseId)?.status ?? node.status,
        output: generatedById.get(node.phaseId)?.output,
        artifacts: [],
      });
    }

    // Also expose detached induction refinement variants as selectable synthetic phases.
    const inductionRefinements = snapshot.phases.phase_e?.output?.details?.generatedRefinements;
    if (Array.isArray(inductionRefinements)) {
      for (const variant of inductionRefinements) {
        if (!variant || typeof variant !== "object") continue;
        const candidate = variant as Record<string, unknown>;
        const variantId = typeof candidate.variantId === "string" ? candidate.variantId : undefined;
        const output = candidate.output;
        const status = typeof candidate.status === "string" && PHASE_STATUSES.includes(candidate.status as PhaseStatus)
          ? (candidate.status as PhaseStatus)
          : "APPROVED";
        if (!variantId) continue;
        map.set(variantId, {
          runId: snapshot.runId,
          phaseId: variantId,
          attempt: 1,
          status,
          output: output && typeof output === "object" ? (output as PhaseSnapshot["output"]) : undefined,
          artifacts: [],
        });
      }
    }

    const mergeNode = renderingSnapshot.nodes.find((node) => node.phaseId === INDUCTION_MERGE_NODE_ID);
    if (mergeNode) {
      map.set(INDUCTION_MERGE_NODE_ID, {
        runId: snapshot.runId,
        phaseId: INDUCTION_MERGE_NODE_ID,
        attempt: 1,
        status: mergeNode.status,
        output: snapshot.phases.phase_e?.output,
        artifacts: [],
      });
    }
    return map;
  }, [
    renderingSnapshot.nodes,
    snapshot.phases.phase_d?.output?.details?.generatedVariants,
    snapshot.phases.phase_e?.output,
    snapshot.runId,
  ]);

  const counts       = computeWorkflowCounts(renderingSnapshot);
  const selectedNode = selectedPhaseId
    ? renderingSnapshot.nodes.find((n) => n.phaseId === selectedPhaseId)
    : null;
  const selectedPhase = selectedPhaseId
    ? snapshot.phases[selectedPhaseId] ?? variantSyntheticPhaseById.get(selectedPhaseId) ?? null
    : null;
  const contextArtifact = selectedPhase?.output?.details?.contextArtifact as
    | { intent?: string; tokens?: string; rubric?: string }
    | undefined;
  const conn = CONNECTION_INDICATOR[connectionStatus];
  const pythonBackendStatus = usePythonBackendHealth();
  const pythonConn = PYTHON_BACKEND_INDICATOR[pythonBackendStatus];
  const [dismissedCompareForPhaseId, setDismissedCompareForPhaseId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const isHumanReviewSurface =
    selectedPhase?.status === "READY_FOR_REVIEW" || selectedPhase?.status === "WAITING_FOR_HUMAN";
  const selectedOutput = selectedPhase?.output;
  const reviewSandboxArtifact = getRenderableArtifact(selectedOutput);
  const fallbackESandboxArtifact = useMemo(() => {
    if (selectedPhaseId !== "phase_e") return null;
    return (
      getRenderableArtifact(snapshot.phases.phase_e?.output) ??
      getRenderableArtifact(snapshot.phases.phase_b?.output) ??
      getRenderableArtifact(snapshot.phases.phase_c?.output)
    );
  }, [selectedPhaseId, snapshot.phases]);
  const activeWorkerSandboxArtifact = reviewSandboxArtifact ?? fallbackESandboxArtifact;
  const shouldShowWorkerIframePreview =
    Boolean(activeWorkerSandboxArtifact) && selectedNode?.phaseType !== "HUMAN";
  const outputProvider = typeof selectedOutput?.details?.provider === "string"
    ? selectedOutput.details.provider.toLowerCase()
    : undefined;
  const rawLlmResponse = typeof selectedOutput?.details?.rawLlmResponse === "string"
    ? selectedOutput.details.rawLlmResponse
    : undefined;
  const hasInductionRefinementVariants =
    Array.isArray(snapshot.phases.phase_e?.output?.details?.generatedRefinements)
    && snapshot.phases.phase_e.output.details.generatedRefinements.length > 0;
  const phaseDMergeOptions = useMemo(() => {
    const rawGenerated = snapshot.phases.phase_d?.output?.details?.generatedVariants;
    if (Array.isArray(rawGenerated) && rawGenerated.length > 0) {
      return rawGenerated
        .map((entry, idx) => {
          if (!entry || typeof entry !== "object") return null;
          const candidate = entry as Record<string, unknown>;
          const variantId = typeof candidate.variantId === "string" ? candidate.variantId : `variant_${idx + 1}`;
          const label = typeof candidate.label === "string" ? candidate.label : variantId;
          return { variantId, label };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
    }
    return [
      { variantId: "phase_b", label: "Variant 1" },
      { variantId: "phase_c", label: "Variant 2" },
    ];
  }, [snapshot.phases.phase_d?.output?.details?.generatedVariants]);
  const compareItems = useMemo(() => {
    const isVariantNode =
      selectedPhaseId === "phase_b"
      || selectedPhaseId === "phase_c"
      || selectedPhaseId?.startsWith("phase_variant_") === true;
    const isInductionVariantNode = selectedPhaseId?.startsWith("phase_e_induction_") === true;
    const isMergerNode =
      selectedPhaseId === "phase_d"
      || selectedPhaseId === INDUCTION_MERGE_NODE_ID;

    if (!selectedPhaseId || (!isVariantNode && !isInductionVariantNode && !isMergerNode)) {
      return [];
    }

    if ((selectedPhaseId === INDUCTION_MERGE_NODE_ID && hasInductionRefinementVariants) || isInductionVariantNode) {
      const rawRefinements = snapshot.phases.phase_e?.output?.details?.generatedRefinements;
      if (Array.isArray(rawRefinements) && rawRefinements.length > 0) {
        const items = rawRefinements
          .map((entry, idx) => {
            if (!entry || typeof entry !== "object") return null;
            const candidate = entry as Record<string, unknown>;
            const artifact = getRenderableArtifact(candidate.output as PhaseOutput);
            if (!artifact) return null;
            const variantId = typeof candidate.variantId === "string" ? candidate.variantId : `induction_${idx + 1}`;
            const label = typeof candidate.label === "string" ? candidate.label : variantId;
            const provider = typeof candidate.provider === "string" ? candidate.provider : "llm";
            return {
              phaseId: variantId,
              label,
              provider,
              artifact,
            };
          })
          .filter((item): item is NonNullable<typeof item> => Boolean(item));
        if (items.length > 0) {
          if (selectedPhaseId === INDUCTION_MERGE_NODE_ID) return items;
          return items.filter((item) => item.phaseId === selectedPhaseId);
        }
      }
    }

    if (selectedPhaseId === "phase_d" || isVariantNode || selectedPhaseId === INDUCTION_MERGE_NODE_ID) {
      const rawGenerated = snapshot.phases.phase_d?.output?.details?.generatedVariants;
      if (Array.isArray(rawGenerated) && rawGenerated.length > 0) {
        const items = rawGenerated
          .map((entry, idx) => {
            if (!entry || typeof entry !== "object") return null;
            const candidate = entry as Record<string, unknown>;
            const artifact = getRenderableArtifact(candidate.output as PhaseOutput);
            if (!artifact) return null;
            const variantId = typeof candidate.variantId === "string" ? candidate.variantId : `variant_${idx + 1}`;
            const label = typeof candidate.label === "string" ? candidate.label : variantId;
            const provider = typeof candidate.provider === "string" ? candidate.provider : "llm";
            return {
              phaseId: variantId,
              label,
              provider,
              artifact,
            };
          })
          .filter((item): item is NonNullable<typeof item> => Boolean(item));
        if (items.length > 0) {
          if (selectedPhaseId === "phase_d") {
            const mergedArtifact = getRenderableArtifact(snapshot.phases.phase_e?.output);
            if (mergedArtifact) {
              return [
                {
                  phaseId: "phase_e_merged",
                  label: "Merged Result",
                  provider:
                    typeof snapshot.phases.phase_e?.output?.details?.provider === "string"
                      ? String(snapshot.phases.phase_e.output?.details?.provider)
                      : "llm",
                  artifact: mergedArtifact,
                },
                ...items,
              ];
            }
            return items;
          }
          if (selectedPhaseId === INDUCTION_MERGE_NODE_ID) return items;
          return items.filter((item) => item.phaseId === selectedPhaseId);
        }
      }
    }

    const preferredIds = selectedPhaseId ? [selectedPhaseId] : [];

    const uniqueIds = Array.from(new Set(preferredIds));
    return uniqueIds
      .map((phaseId) => {
        const phase = snapshot.phases[phaseId];
        const artifact = getRenderableArtifact(phase?.output);
        if (!phase || !artifact) return null;
        return {
          phaseId,
          label: renderingSnapshot.nodes.find((n) => n.phaseId === phaseId)?.label ?? phaseId,
          provider:
            typeof phase.output?.details?.provider === "string"
              ? String(phase.output?.details?.provider)
              : "llm",
          artifact,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }, [
    selectedPhaseId,
    hasInductionRefinementVariants,
    renderingSnapshot.nodes,
    snapshot.phases,
  ]);
  const previewDockItems = compareItems.length > 0
    ? compareItems
    : shouldShowWorkerIframePreview && activeWorkerSandboxArtifact && selectedPhaseId && selectedNode
      ? [
          {
            phaseId: selectedPhaseId,
            label: selectedNode.label,
            provider: outputProvider ?? "llm",
            artifact: activeWorkerSandboxArtifact,
          },
        ]
      : [];
  const previewDockOpen =
    previewDockItems.length > 0 && dismissedCompareForPhaseId !== (selectedPhaseId ?? "__none__");
  const inductionMergeVariants = useMemo(() => {
    const raw = snapshot.phases.phase_e?.output?.details?.generatedRefinements;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const candidate = entry as Record<string, unknown>;
        const variantId = typeof candidate.variantId === "string" ? candidate.variantId : undefined;
        const label = typeof candidate.label === "string" ? candidate.label : variantId;
        const status = typeof candidate.status === "string" ? candidate.status : undefined;
        const hasOutput = Boolean(getRenderableArtifact(candidate.output as PhaseOutput));
        if (!variantId || !label) return null;
        return { variantId, label, status, hasOutput };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }, [snapshot.phases.phase_e?.output?.details?.generatedRefinements]);

  // Phase A (HUMAN + DRAFT) shows the context-init form instead of a plain Start button.
  const isContextInit = selectedNode?.phaseId === "phase_a" && selectedPhase?.status === "DRAFT";
  const isMergeReviewInit = selectedNode?.phaseId === "phase_d" && selectedPhase?.status === "DRAFT";
  const isInductionMergeSurface =
    selectedNode?.phaseId === INDUCTION_MERGE_NODE_ID
    && inductionMergeVariants.some((variant) => variant.hasOutput)
    && (selectedPhase?.status === "DRAFT" || selectedPhase?.status === "COMPLETED");
  const phaseEReadyForInduction =
    snapshot.phases.phase_e?.status === "COMPLETED" || snapshot.phases.phase_e?.status === "APPROVED";
  const isComponentInductionSurface =
    (selectedNode?.phaseId === "phase_e" && phaseEReadyForInduction)
    || (selectedNode?.phaseId === INDUCTION_MERGE_NODE_ID && phaseEReadyForInduction);

  function downloadArtifactHtml(filenamePrefix: string, artifact: PreviewCodeArtifact) {
    const blob = new Blob([artifact.code], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filenamePrefix}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function handleResetWorkflow() {
    try {
      const response = await fetch(`/api/workflows/${WORKFLOW_RUN_ID}/reset`, {
        method: "POST",
      });
      if (!response.ok) return;
      const fresh = await response.json();
      setSnapshot(fresh);
      selectPhase(null);
    } catch {
      // no-op: existing snapshot remains usable if reset request fails
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-800 px-5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold tracking-tight text-slate-100">
            Backtrack Orchestra
          </span>
          <span className="h-4 w-px bg-slate-700" />
          <span className="font-mono text-xs text-slate-400" data-testid="workflow-title">
            {snapshot.workflowId}
          </span>
          <span className="h-4 w-px bg-slate-700" />
          <span className="font-mono text-xs text-slate-500">{snapshot.runId}</span>
        </div>

        {/* Phase counts */}
        <div className="flex items-center gap-5 text-xs" data-testid="workflow-counts">
          <span>
            <span className="font-medium text-slate-200">{counts.total}</span>
            <span className="ml-1 text-slate-500">phases</span>
          </span>
          <span>
            <span className="font-medium text-blue-400">{counts.running}</span>
            <span className="ml-1 text-slate-500">running</span>
          </span>
          <span>
            <span className="font-medium text-amber-400">{counts.humanQueue}</span>
            <span className="ml-1 text-slate-500">awaiting review</span>
          </span>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-400" htmlFor="branch-factor">
            <span>Branches</span>
            <select
              id="branch-factor"
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:opacity-50"
              value={effectiveBranchFactor}
              onChange={(e) => setBranchFactor(Number(e.target.value))}
              disabled={isBranchFactorLocked}
            >
              {Array.from({ length: 7 }, (_, i) => i + 2).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          {/* SSE connection status — goes green in M2 */}
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <span className={`inline-block h-2 w-2 rounded-full ${conn.dot}`} />
            {conn.label}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <span className={`inline-block h-2 w-2 rounded-full ${pythonConn.dot}`} />
            {pythonConn.label}
          </span>

          {/* Dev button: dispatches through store to prove DoD item 2 */}

          <button
            className="rounded bg-slate-800 px-3 py-1 text-xs text-slate-300 transition-colors hover:bg-slate-700 hover:text-slate-100"
            data-testid="reset-workflow"
            onClick={handleResetWorkflow}
            type="button"
          >
            Reset Workflow
          </button>
          <button
            className="rounded bg-slate-800 px-3 py-1 text-xs text-slate-300 transition-colors hover:bg-slate-700 hover:text-slate-100"
            data-testid="open-workflow-help"
            onClick={() => setHelpOpen(true)}
            type="button"
          >
            Help
          </button>
        </div>
      </header>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* DAG canvas */}
        <main className="relative flex-1 overflow-hidden">
          <WorkflowDAG
            snapshot={renderingSnapshot}
            selectedPhaseId={selectedPhaseId ?? undefined}
            onSelectPhase={selectPhase}
          />
          {previewDockOpen ? (
            <div
              className="absolute inset-x-4 bottom-4 z-20 rounded-xl border border-slate-700 bg-slate-950/95 p-3 shadow-2xl"
              style={{ resize: "both", overflow: "auto", minHeight: "260px", maxHeight: "75%" }}
              data-testid="review-compare-grid"
            >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-200">
                  {previewDockItems.length > 1 ? "Review Compare Grid" : "Preview Dock"}
                </p>
                <button
                  type="button"
                  className="rounded bg-slate-800 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-700"
                  onClick={() => setDismissedCompareForPhaseId(selectedPhaseId ?? "__none__")}
                >
                  Close
                </button>
              </div>
              <div className={`grid gap-3 ${previewDockItems.length > 1 ? "md:grid-cols-2" : "grid-cols-1"}`}>
                {previewDockItems.map((item) => (
                  <div
                    key={item.phaseId}
                    className="rounded-lg border border-slate-700 bg-slate-900 p-2"
                    style={{ resize: "both", overflow: "auto", minHeight: "220px" }}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-[11px] font-medium text-slate-200">{item.label}</p>
                      <div className="flex items-center gap-1">
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                          {item.provider}
                        </span>
                        <button
                          type="button"
                          className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-200 hover:bg-slate-700"
                          onClick={() => downloadArtifactHtml(item.phaseId, item.artifact)}
                        >
                          Download HTML
                        </button>
                      </div>
                    </div>
                    <StrictSandboxCodePreview artifact={item.artifact} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </main>

        {/* ── Right panel ────────────────────────────────────────────────── */}
        <aside
          className="flex w-72 shrink-0 flex-col border-l border-slate-800 bg-slate-900"
          data-testid="phase-detail-panel"
        >
          {selectedPhase && selectedNode ? (
            <div className="flex flex-col gap-5 overflow-y-auto p-5">
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    {selectedNode.phaseType} phase
                  </p>
                  <h2 className="mt-0.5 text-base font-semibold text-slate-100">
                    {selectedNode.label}
                  </h2>
                </div>
                <button
                  onClick={() => selectPhase(null)}
                  className="mt-0.5 text-slate-500 transition-colors hover:text-slate-300"
                  aria-label="Close panel"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-4 w-4"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              </div>

              {/* Status */}
              <Field label="Status">
                <span className={`text-sm font-medium ${STATUS_COLOR[selectedPhase.status]}`}>
                  {selectedPhase.status.replace(/_/g, " ")}
                </span>
              </Field>

              {/* Output */}
              {selectedPhase.output ? (
                <Field label="Output">
                  <div className="flex flex-col gap-3">
                    {previewDockItems.length > 0 && !previewDockOpen ? (
                      <button
                        type="button"
                        className="rounded border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200 hover:bg-slate-700"
                        onClick={() => setDismissedCompareForPhaseId(null)}
                      >
                        Open Preview Dock
                      </button>
                    ) : null}
                    {isHumanReviewSurface && reviewSandboxArtifact ? (
                      <div className="rounded-lg border border-slate-700 bg-slate-900 p-3" data-testid="review-code-bin">
                        <div className="mb-1 flex items-center justify-between">
                          <p className="text-[10px] uppercase tracking-wider text-slate-400">Code Bin (Rendered HTML)</p>
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
                            {outputProvider ?? "llm"}
                          </span>
                        </div>
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-200">
                          {reviewSandboxArtifact.code}
                        </pre>
                      </div>
                    ) : null}
                    {isHumanReviewSurface ? (
                      <div className="rounded-lg border border-slate-700 bg-slate-800/70 p-3">
                        <p className="text-[10px] uppercase tracking-wider text-slate-500">Concept Summary</p>
                        <p className="mt-1 text-xs leading-relaxed text-slate-200">
                          {getConceptOneLiner(selectedPhase.output.diff)}
                        </p>
                        {selectedPhase.output.rubricResults?.length ? (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {selectedPhase.output.rubricResults.slice(0, 3).map((item, idx) => (
                              <span
                                key={`${item.criterion}-${idx}`}
                                className="rounded bg-slate-700 px-2 py-0.5 text-[10px] text-slate-200"
                              >
                                {item.criterion}: {item.score}/{item.maxScore}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {selectedNode.phaseId === "phase_a" && contextArtifact ? (
                      <PhaseAProofCard
                        contextArtifact={contextArtifact}
                        generatedBrief={selectedPhase.output.diff}
                      />
                    ) : null}
                    {selectedPhase.output.diff ? (
                      <div className="rounded bg-slate-800 p-3">
                        <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Summary</p>
                        <pre className="whitespace-pre-wrap break-all font-mono text-[10px] text-slate-300">
                          {selectedPhase.output.diff}
                        </pre>
                      </div>
                    ) : null}
                    {rawLlmResponse ? (
                      <div className="rounded bg-slate-800 p-3">
                        <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Raw LLM Response</p>
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-slate-300">
                          {rawLlmResponse}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                </Field>
              ) : (
                <div className="rounded border border-dashed border-slate-700 p-3 text-center">
                  <p className="text-xs text-slate-600">Diff / Rubric</p>
                  <p className="mt-0.5 text-[10px] text-slate-700">
                    Available after phase completes (M4)
                  </p>
                </div>
              )}

              {/* ── Action area: context-init form OR standard buttons ─── */}
              {phaseAction.loading ? (
                <div className="rounded border border-sky-700/50 bg-sky-950/30 p-3 text-xs text-sky-200">
                  <p className="text-[11px] font-medium">
                    {phaseAction.loadingAction
                      ? `${ACTION_LABEL[phaseAction.loadingAction]} in progress`
                      : "Applying action"}
                  </p>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-slate-800/80">
                    <div className="h-full w-2/3 animate-pulse rounded bg-sky-400" />
                  </div>
                </div>
              ) : null}
              {isContextInit ? (
                // HUMAN phase in DRAFT → show the context initialization form.
                // The form's submit dispatches START_PHASE with structured payload.
                <Field label="Initialize Context">
                  <ContextInitForm
                    dispatch={phaseAction.dispatch}
                    loading={phaseAction.loading}
                    error={phaseAction.error}
                    branchFactor={effectiveBranchFactor}
                  />
                </Field>
              ) : isMergeReviewInit ? (
                <Field label="Review + Merge">
                  <MergeReviewForm
                    dispatch={phaseAction.dispatch}
                    loading={phaseAction.loading}
                    error={phaseAction.error}
                    variants={phaseDMergeOptions}
                  />
                </Field>
              ) : isInductionMergeSurface || isComponentInductionSurface ? (
                <>
                  {isComponentInductionSurface ? (
                    <Field label="Component Induction">
                      <ComponentInductionForm
                        dispatch={phaseAction.dispatch}
                        loading={phaseAction.loading}
                        error={phaseAction.error}
                      />
                    </Field>
                  ) : null}
                  {isInductionMergeSurface ? (
                    <Field label="Induction Merge">
                      <InductionMergeForm
                        dispatch={phaseAction.dispatch}
                        loading={phaseAction.loading}
                        error={phaseAction.error}
                        variants={inductionMergeVariants}
                        exportHtml={snapshot.phases.phase_e?.output?.uiCode?.code}
                      />
                    </Field>
                  ) : null}
                </>
              ) : (
                // All other actionable statuses → standard action buttons.
                (() => {
                  // For HUMAN phases that are already running/reviewing, START is
                  // handled by the form above; filter it out of the button list.
                  const actions = getAvailableActions(selectedPhase.status).filter(
                    (a: WorkflowActionType) =>
                      !(selectedNode?.phaseType === "HUMAN" && a === "START_PHASE"),
                  );
                  if (actions.length === 0) return null;
                  return (
                    <Field label="Actions">
                      <div className="flex flex-col gap-2" data-testid="phase-action-controls">
                        {actions.map((action: WorkflowActionType) => (
                          <button
                            key={action}
                            data-testid={`action-btn-${action.toLowerCase().replace(/_/g, "-")}`}
                            disabled={phaseAction.loading}
                            onClick={() => phaseAction.dispatch(action)}
                            className={`rounded px-3 py-1.5 text-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-900 disabled:opacity-50 ${ACTION_BUTTON_CLASS[action]}`}
                            type="button"
                          >
                            {phaseAction.loading && phaseAction.loadingAction === action
                              ? `${ACTION_LABEL[action]}...`
                              : ACTION_LABEL[action]}
                          </button>
                        ))}
                        {phaseAction.error && (
                          <p className="rounded bg-red-950 px-2 py-1 font-mono text-[10px] text-red-400">
                            {phaseAction.error}
                          </p>
                        )}
                      </div>
                    </Field>
                  );
                })()
              )}

              {/* Error */}
              {selectedPhase.error && (
                <Field label="Error">
                  <p className="rounded bg-red-950 p-2 font-mono text-xs text-red-300">
                    {selectedPhase.error}
                  </p>
                </Field>
              )}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-8 w-8 text-slate-700"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"
                />
              </svg>
              <p className="mt-2 text-sm text-slate-500">Select a phase</p>
              <p className="text-xs text-slate-600">to inspect details</p>
            </div>
          )}
        </aside>
      </div>

      {/* Hidden list preserving test IDs for Playwright DOM queries in M2+ */}
      <ul className="sr-only" aria-hidden data-testid="workflow-node-list">
        {renderingSnapshot.nodes.map((node) => (
          <li key={node.phaseId} data-testid={`node-${node.phaseId}`} data-status={node.status}>
            <span data-testid={`status-${node.phaseId}`}>{node.status}</span>
          </li>
        ))}
      </ul>

      {helpOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Workflow Help"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">How To Use This Workflow</h2>
              <button
                type="button"
                className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
                onClick={() => setHelpOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="space-y-3 text-xs text-slate-300">
              <p>1. Initialize context in Phase A with your design intent.</p>
              <p>2. Review generated variants (B/C and additional branches).</p>
              <p>3. Use Human Review (phase_d) to choose merge direction and provide merge instruction.</p>
              <p>4. Merge + Finalize produces the latest merged HTML.</p>
              <p>5. Use induction to refine a specific component only, then merge a preferred induction variant.</p>
              <p>6. Repeat induction + merge as needed, or export HTML and stop.</p>
              <p className="rounded border border-slate-700 bg-slate-800 p-2 text-slate-200">
                Induction is for fine-tuning targeted sub-components, not full-page redesigns.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</p>
      {children}
    </div>
  );
}
