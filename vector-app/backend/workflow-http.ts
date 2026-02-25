import { NextResponse } from "next/server";
import {
  type PhaseType,
  type PhaseOutput,
  type WorkflowActionRequest,
  type WorkflowActionType,
} from "@/contracts/workflow-contract";
import type {
  PreviewCodeArtifact,
  PreviewSchemaRoot,
  StructuredPhaseOutputPayload,
} from "@/contracts/preview-schema";
import {
  applyWorkflowAction,
  getContractVersion,
  getWorkflowSnapshot,
  markPhaseCompleted,
  persistPhaseOutput,
} from "@/backend/workflow-engine";
import { callLlmBatch, callLlmForPhase, requiresLlmPhaseExecution } from "@/backend/llm-client";

interface RouteParams {
  params: Promise<{ runId: string; phaseId: string }>;
}

interface ContextInitPayload {
  intent: string;
  tokens?: string;
  rubric?: string;
  branchFactor?: number;
}

interface MergeReviewPayload {
  mergerExplanation: string;
  splitNodeHint?: string;
  selectedVariantIds?: string[];
}

interface ComponentRefinementPayload {
  componentSelector: string;
  refinementPrompt: string;
}

interface InductionMergePayload {
  selectedVariantId: string;
  mergeRationale?: string;
}

interface PermutationSpec {
  variantId: string;
  label: string;
  index: number;
  total: number;
  intensity: number;
  phaseId?: "phase_b" | "phase_c";
}

function isContextInitPhase(phaseId: string, phaseType?: PhaseType): boolean {
  void phaseType;
  return phaseId === "phase_a";
}

function parseContextInitPayload(payload: unknown): ContextInitPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.intent !== "string" || candidate.intent.trim().length === 0) return null;
  return {
    intent: candidate.intent.trim(),
    tokens:
      typeof candidate.tokens === "string" && candidate.tokens.trim()
        ? candidate.tokens.trim()
        : undefined,
    rubric:
      typeof candidate.rubric === "string" && candidate.rubric.trim()
        ? candidate.rubric.trim()
        : undefined,
    branchFactor:
      typeof candidate.branchFactor === "number"
        ? Math.min(8, Math.max(2, Math.round(candidate.branchFactor)))
        : undefined,
  };
}

function buildStructuredOutputPrompt(phaseId: string, runId: string, context?: ContextInitPayload): string {
  const contextBlock = context
    ? [
        `Intent: ${context.intent}`,
        context.tokens
          ? `Design Tokens & Constraints: ${context.tokens}`
          : "Design Tokens & Constraints: (none provided)",
        context.rubric
          ? `Evaluation Rubric: ${context.rubric}`
          : "Evaluation Rubric: (none provided)",
      ].join("\n")
    : "";

  return [
    `You are generating a safe UI preview artifact for phase '${phaseId}' in run '${runId}'.`,
    "Respond with JSON ONLY (no markdown fences) using this shape:",
    '{"renderMode":"schema","uiSchema":{"version":1,"tokens":{"accentColor":"#8B5CF6","radius":"md","spacing":"md"},"tree":[{"id":"root","type":"container","children":[{"id":"title","type":"heading","text":"..."},{"id":"desc","type":"text","text":"..."},{"id":"cta","type":"button","text":"...", "variant":"primary"}]}]},"uiCode":{"language":"html","code":"<main><h1>...</h1><p>...</p><button>...</button></main>"},"diff":"...","rubricResults":[{"criterion":"...","score":4,"maxScore":5,"note":"..."}]}',
    "Allowed node types for uiSchema: container, heading, text, button, input.",
    "Preferred mode is renderMode='code' with a complete website concept in uiCode.code.",
    "uiCode.language must be 'html' and should include meaningful structure (hero, body sections, CTA, optional footer).",
    "Never include scripts, event handlers, iframes, object/embed, remote URLs, javascript: URLs, or external assets.",
    "Keep uiSchema populated as a safe fallback representation even when renderMode='code'.",
    contextBlock,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseMergeReviewPayload(payload: unknown): MergeReviewPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.mergerExplanation !== "string" || candidate.mergerExplanation.trim().length === 0) {
    return null;
  }
  return {
    mergerExplanation: candidate.mergerExplanation.trim(),
    splitNodeHint:
      typeof candidate.splitNodeHint === "string" && candidate.splitNodeHint.trim().length > 0
        ? candidate.splitNodeHint.trim()
        : undefined,
    selectedVariantIds: Array.isArray(candidate.selectedVariantIds)
      ? candidate.selectedVariantIds
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map((entry) => entry.trim())
      : undefined,
  };
}

function parseComponentRefinementPayload(payload: unknown): ComponentRefinementPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.componentSelector !== "string" || candidate.componentSelector.trim().length === 0) {
    return null;
  }
  if (typeof candidate.refinementPrompt !== "string" || candidate.refinementPrompt.trim().length === 0) {
    return null;
  }
  return {
    componentSelector: candidate.componentSelector.trim(),
    refinementPrompt: candidate.refinementPrompt.trim(),
  };
}

function parseInductionMergePayload(payload: unknown): InductionMergePayload | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.selectedVariantId !== "string" || candidate.selectedVariantId.trim().length === 0) {
    return null;
  }
  return {
    selectedVariantId: candidate.selectedVariantId.trim(),
    mergeRationale:
      typeof candidate.mergeRationale === "string" && candidate.mergeRationale.trim().length > 0
        ? candidate.mergeRationale.trim()
        : undefined,
  };
}

function buildComponentRefinementPrompt(params: {
  runId: string;
  componentSelector: string;
  refinementPrompt: string;
  currentHtml: string;
  branchLabel?: string;
  branchIndex?: number;
  branchTotal?: number;
  branchIntensity?: number;
}): string {
  const branchLine =
    typeof params.branchIndex === "number" && typeof params.branchTotal === "number"
      ? `Induction branch ${params.branchIndex + 1}/${params.branchTotal}${params.branchLabel ? ` (${params.branchLabel})` : ""}.`
      : "";
  return [
    `You are refining a FINAL merged HTML artifact for run '${params.runId}'.`,
    "You MUST only refine the specified subset of components.",
    `Target subset selector: ${params.componentSelector}`,
    branchLine,
    typeof params.branchIntensity === "number"
      ? `Branch intensity: ${params.branchIntensity.toFixed(2)} where 0.00 is conservative and 1.00 is bolder.`
      : "",
    "Keep all other parts of the HTML semantically and visually consistent unless required for local compatibility.",
    "Preserve non-target components exactly unless a direct target dependency requires a minimal local change.",
    "Your output will replace the current HTML directly. It MUST be the same document with ONLY targeted component edits.",
    "Do NOT redesign unrelated sections, rename unrelated ids/classes, or reorder unrelated structure.",
    "Return JSON ONLY with uiCode.language='html' and full uiCode.code for the entire page.",
    "Also include diff and rubricResults fields.",
    "The response must explicitly mention the target selector in diff to confirm scoped edit.",
    "",
    `User refinement request: ${params.refinementPrompt}`,
    "",
    "Current HTML:",
    params.currentHtml,
  ].join("\n");
}

function buildInductionSpecs(branchFactor: number): Array<{
  variantId: string;
  label: string;
  index: number;
  total: number;
  intensity: number;
}> {
  const specs = buildPermutationSpecs(branchFactor);
  return specs.map((spec) => ({
    variantId: `phase_e_induction_${spec.index + 1}`,
    label: spec.label,
    index: spec.index,
    total: spec.total,
    intensity: spec.intensity,
  }));
}

function resolveOutputHtmlForRefinement(output?: PhaseOutput): string {
  if (output?.uiCode?.code && looksLikeHtmlSnippet(output.uiCode.code)) {
    return output.uiCode.code;
  }
  if (output?.uiSchema?.tree?.length) {
    const rootSummary = output.uiSchema.tree
      .map((node) => `${node.type}:${node.id}`)
      .join(" | ");
    return `<main id="generated-from-schema"><section data-source="schema">${rootSummary}</section></main>`;
  }
  return "";
}

function buildFinalMergePrompt(params: {
  runId: string;
  mergerExplanation: string;
  splitNodeHint?: string;
  variants: Array<{ variantId: string; label: string; output?: PhaseOutput }>;
  preferredVariantIds: string[];
}): string {
  const variantBlocks = params.variants
    .map((variant) => {
      const html = resolveOutputHtmlForRefinement(variant.output);
      const diff = variant.output?.diff ?? "";
      return [
        `Variant ID: ${variant.variantId}`,
        `Variant Label: ${variant.label}`,
        "Variant HTML:",
        html || "(no html provided)",
        "Variant Notes:",
        diff || "(no notes)",
      ].join("\n");
    })
    .join("\n\n---\n\n");

  const preferredLine = params.preferredVariantIds.length > 0
    ? `Preferred variants mentioned by user: ${params.preferredVariantIds.join(", ")}`
    : "Preferred variants mentioned by user: none detected; infer from rationale.";

  return [
    `You are merging prior UI variants for final phase_e in run '${params.runId}'.`,
    "Return JSON ONLY using uiCode.language='html' and full uiCode.code for the merged page.",
    "Merge task: produce one final HTML by combining previous variants.",
    "Use MAJORITY code from the preferred variants the user indicates, and only blend portions from others where rationale requires it.",
    "Do not default to the first variant. Choose the strongest base from rationale.",
    preferredLine,
    params.splitNodeHint ? `Target local component emphasis: ${params.splitNodeHint}` : "",
    `Human merge rationale: ${params.mergerExplanation}`,
    "",
    "You must preserve coherent structure and accessibility while integrating requested blend.",
    "",
    "Variants:",
    variantBlocks,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function inferPreferredVariantIds(
  variants: Array<{ variantId: string; label: string; output?: PhaseOutput }>,
  rationale: string,
): string[] {
  const text = rationale.toLowerCase();
  const selected = new Set<string>();

  for (const variant of variants) {
    const labelLower = variant.label.toLowerCase();
    const labelCore = labelLower.replace(/\bvariant\b/g, "").trim();
    const idLower = variant.variantId.toLowerCase();
    if (
      text.includes(labelLower) ||
      (labelCore.length > 0 && text.includes(labelCore)) ||
      text.includes(idLower)
    ) {
      selected.add(variant.variantId);
    }
  }

  if (/\bphase[_\s-]?b\b|\bvariant b\b/.test(text)) selected.add("phase_b");
  if (/\bphase[_\s-]?c\b|\bvariant c\b/.test(text)) selected.add("phase_c");

  if (selected.size > 0) return Array.from(selected);

  if (text.includes("very light")) {
    const light = variants.find((variant) => variant.label.toLowerCase().includes("very light"));
    if (light) return [light.variantId];
  }
  if (text.includes("very dark")) {
    const dark = variants.find((variant) => variant.label.toLowerCase().includes("very dark"));
    if (dark) return [dark.variantId];
  }
  if (text.includes("light")) {
    const light = variants.find((variant) => variant.label.toLowerCase().includes("light"));
    if (light) return [light.variantId];
  }
  if (text.includes("dark")) {
    const dark = variants.find((variant) => variant.label.toLowerCase().includes("dark"));
    if (dark) return [dark.variantId];
  }

  return [];
}

function buildPermutationPrompt(
  phaseId: string,
  runId: string,
  context: ContextInitPayload,
  spec: PermutationSpec,
): string {
  const base = buildStructuredOutputPrompt(phaseId, runId, context);
  const modeInstruction =
    spec.intensity <= 0.5
      ? "Permutation mode: darker color scheme, higher contrast surfaces, still readable and accessible."
      : "Permutation mode: lighter color scheme, brighter surfaces, still readable and accessible.";

  return [
    base,
    "Output should represent a full website concept (hero + supporting content + clear CTA), not a short status snippet.",
    `Variant ${spec.index + 1}/${spec.total}.`,
    `Gradient intensity: ${spec.intensity.toFixed(2)} where 0.00 = darkest and 1.00 = lightest.`,
    modeInstruction,
    "Keep returning JSON with uiCode.language='html' and complete uiCode.code HTML.",
  ].join("\n\n");
}

function buildPermutationSpecs(branchFactor: number): PermutationSpec[] {
  const factor = Math.min(8, Math.max(2, Math.round(branchFactor)));
  return Array.from({ length: factor }, (_, index) => {
    const intensity = factor === 1 ? 0 : index / (factor - 1);
    const phaseId = index === 0 ? "phase_b" : index === factor - 1 ? "phase_c" : undefined;
    const modeLabel = intensity <= 0.2
      ? "Very Dark"
      : intensity <= 0.4
        ? "Dark"
        : intensity <= 0.6
          ? "Balanced"
          : intensity <= 0.8
            ? "Light"
            : "Very Light";
    return {
      variantId: phaseId ?? `phase_variant_${index + 1}`,
      label: `${modeLabel} Variant`,
      index,
      total: factor,
      intensity,
      phaseId,
    };
  });
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return trimmed.slice(firstBrace, lastBrace + 1);
  return "";
}

function sanitizeSchemaNode(node: unknown): PreviewSchemaRoot["tree"][number] | null {
  if (!node || typeof node !== "object") return null;
  const candidate = node as Record<string, unknown>;
  const type = candidate.type;
  const id = candidate.id;
  if (
    typeof id !== "string" ||
    !["container", "heading", "text", "button", "input"].includes(String(type))
  ) {
    return null;
  }
  const children = Array.isArray(candidate.children)
    ? candidate.children
        .map((child) => sanitizeSchemaNode(child))
        .filter((child): child is NonNullable<typeof child> => Boolean(child))
    : undefined;

  return {
    id,
    type: type as PreviewSchemaRoot["tree"][number]["type"],
    text: typeof candidate.text === "string" ? candidate.text : undefined,
    placeholder: typeof candidate.placeholder === "string" ? candidate.placeholder : undefined,
    variant: candidate.variant === "secondary" ? "secondary" : candidate.variant === "primary" ? "primary" : undefined,
    children,
  };
}

function fallbackSchema(phaseId: string): PreviewSchemaRoot {
  return {
    version: 1,
    tokens: { accentColor: "#8B5CF6", radius: "md", spacing: "md" },
    tree: [
      {
        id: `${phaseId}_root`,
        type: "container",
        children: [
          { id: `${phaseId}_title`, type: "heading", text: `Preview for ${phaseId}` },
          {
            id: `${phaseId}_body`,
            type: "text",
            text: "Model output was normalized into constrained preview components.",
          },
          { id: `${phaseId}_cta`, type: "button", text: "Primary Action", variant: "primary" },
        ],
      },
    ],
  };
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

function extractHtmlSnippet(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function looksLikeHtmlSnippet(raw: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(raw);
}

function parseCodeArtifact(candidate: unknown): PreviewCodeArtifact | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  if (record.language !== "html" || typeof record.code !== "string") return undefined;
  const rawCode = extractHtmlSnippet(record.code);
  if (!looksLikeHtmlSnippet(rawCode)) return undefined;

  const cleaned = sanitizeGeneratedHtml(rawCode);
  if (!cleaned.safe) return undefined;

  return {
    language: "html",
    code: cleaned.sanitized,
    sanitized: cleaned.changed,
  };
}

function parseStructuredOutput(raw: string, phaseId: string): StructuredPhaseOutputPayload {
  const trimmed = raw.trim();
  const looksJsonLike = trimmed.startsWith("{") || trimmed.startsWith("[") || /^```json/i.test(trimmed);
  const directHtmlCode = looksJsonLike ? undefined : parseCodeArtifact({ language: "html", code: raw });
  if (directHtmlCode) {
    return {
      renderMode: "code",
      uiSchema: fallbackSchema(phaseId),
      uiCode: directHtmlCode,
      diff: "Direct HTML output received from LLM and rendered in sandbox.",
      rubricResults: [
        {
          criterion: "HTML renderability",
          score: 4,
          maxScore: 5,
          note: "Raw model HTML passed sanitization and was rendered directly",
        },
      ],
    };
  }

  try {
    const jsonText = extractJsonObject(raw);
    const parsed = JSON.parse(jsonText) as Partial<StructuredPhaseOutputPayload>;
    const candidateTree = Array.isArray(parsed.uiSchema?.tree) ? parsed.uiSchema.tree : [];
    const tree = candidateTree
      .map((node) => sanitizeSchemaNode(node))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
    const hasTree = tree.length > 0;
    const parsedCode = parseCodeArtifact(parsed.uiCode);
    const renderMode = parsed.renderMode === "code" && parsedCode ? "code" : "schema";

    return {
      renderMode,
      uiSchema: hasTree
        ? {
            version: 1,
            tokens: parsed.uiSchema?.tokens,
            tree,
          }
        : fallbackSchema(phaseId),
      uiCode: parsedCode,
      diff: typeof parsed.diff === "string" && parsed.diff.trim() ? parsed.diff : raw.trim(),
      rubricResults: Array.isArray(parsed.rubricResults) && parsed.rubricResults.length > 0
        ? parsed.rubricResults.map((r) => ({
            criterion: typeof r.criterion === "string" ? r.criterion : "Quality",
            score: typeof r.score === "number" ? r.score : 3,
            maxScore: typeof r.maxScore === "number" ? r.maxScore : 5,
            note: typeof r.note === "string" ? r.note : undefined,
          }))
        : [
            {
              criterion: "Constrained schema validity",
              score: 4,
              maxScore: 5,
              note: "Auto-filled because model rubric was missing",
            },
          ],
    };
  } catch {
    return {
      renderMode: "schema",
      uiSchema: fallbackSchema(phaseId),
      diff: raw.trim() || "Model response could not be parsed. Fallback schema rendered.",
      rubricResults: [
        {
          criterion: "Structured output parse",
          score: 3,
          maxScore: 5,
          note: "Response was non-JSON; fallback preview used",
        },
      ],
    };
  }
}

function shouldExecuteLlm(action: WorkflowActionType, phaseId: string, phaseType?: PhaseType): boolean {
  if (!(action === "START_PHASE" || action === "RETRY_PHASE")) return false;
  if (phaseId === "phase_e") return action === "RETRY_PHASE";
  return requiresLlmPhaseExecution(phaseType) || isContextInitPhase(phaseId, phaseType);
}

export async function handleActionRequest(
  request: Request,
  context: RouteParams,
  action: WorkflowActionType,
) {
  const body = (await request.json()) as Partial<WorkflowActionRequest>;
  const { runId, phaseId } = await context.params;
  const actorId = body.actorId;

  if (!actorId || typeof actorId !== "string") {
    return NextResponse.json(
      { accepted: false, runId, phaseId, status: "ERROR_STATUS", message: "actorId is required" },
      { status: 400, headers: { "x-contract-version": getContractVersion() } },
    );
  }

  if (body.action && body.action !== action) {
    return NextResponse.json(
      {
        accepted: false,
        runId,
        phaseId,
        status: "ERROR_STATUS",
        message: `Action mismatch: expected ${action}, received ${body.action}`,
      },
      { status: 400, headers: { "x-contract-version": getContractVersion() } },
    );
  }

  const runSnapshot = getWorkflowSnapshot(runId);
  const preActionPhaseEOutput = runSnapshot.phases.phase_e?.output;
  const phaseNode = runSnapshot.nodes.find((node) => node.phaseId === phaseId);
  const phaseType = phaseNode?.phaseType as PhaseType | undefined;
  const isPhaseAContextInit = isContextInitPhase(phaseId, phaseType);
  const isPhaseDMergeReview = phaseId === "phase_d" && phaseType === "HUMAN";
  const isPhaseEInduction = phaseId === "phase_e";
  const parsedInductionMergePayload = isPhaseEInduction ? parseInductionMergePayload(body.payload) : null;
  const isPhaseEInductionMergeAction =
    isPhaseEInduction && action === "START_PHASE" && Boolean(parsedInductionMergePayload);
  const shouldCallLlm = shouldExecuteLlm(action, phaseId, phaseType);
  const parsedContextPayload = isPhaseAContextInit ? parseContextInitPayload(body.payload) : null;
  const parsedMergeReviewPayload = isPhaseDMergeReview ? parseMergeReviewPayload(body.payload) : null;
  const parsedComponentRefinementPayload = isPhaseEInduction
    ? parseComponentRefinementPayload(body.payload)
    : null;

  if (isPhaseAContextInit && action === "START_PHASE" && !parsedContextPayload) {
    return NextResponse.json(
      {
        accepted: false,
        runId,
        phaseId,
        status: "ERROR_STATUS",
        message: "Phase A requires payload.intent (non-empty string)",
      },
      { status: 400, headers: { "x-contract-version": getContractVersion() } },
    );
  }

  if (isPhaseDMergeReview && action === "START_PHASE" && !parsedMergeReviewPayload) {
    return NextResponse.json(
      {
        accepted: false,
        runId,
        phaseId,
        status: "ERROR_STATUS",
        message: "Phase D requires payload.mergerExplanation (non-empty string)",
      },
      { status: 400, headers: { "x-contract-version": getContractVersion() } },
    );
  }

  if (isPhaseEInduction && action === "RETRY_PHASE" && !parsedComponentRefinementPayload) {
    return NextResponse.json(
      {
        accepted: false,
        runId,
        phaseId,
        status: "ERROR_STATUS",
        message: "Phase E refinement requires payload.componentSelector and payload.refinementPrompt",
      },
      { status: 400, headers: { "x-contract-version": getContractVersion() } },
    );
  }

  if (isPhaseEInduction && action === "RETRY_PHASE" && parsedComponentRefinementPayload) {
    const currentHtml = resolveOutputHtmlForRefinement(runSnapshot.phases.phase_e?.output);
    if (!currentHtml || !currentHtml.includes(parsedComponentRefinementPayload.componentSelector)) {
      return NextResponse.json(
        {
          accepted: false,
          runId,
          phaseId,
          status: "ERROR_STATUS",
          message: `Selector '${parsedComponentRefinementPayload.componentSelector}' was not found in current final HTML`,
        },
        { status: 400, headers: { "x-contract-version": getContractVersion() } },
      );
    }
  }

  let actionResult: ReturnType<typeof applyWorkflowAction> | undefined;

  if (action === "RETRY_PHASE" && shouldCallLlm) {
    try {
      actionResult = applyWorkflowAction({
        action,
        actorId: actorId,
        payload: body.payload,
        phaseId,
        reason: body.reason,
        runId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown action failure";
      return NextResponse.json(
        { accepted: false, runId, phaseId, status: "ERROR_STATUS", message },
        { status: 404, headers: { "x-contract-version": getContractVersion() } },
      );
    }
  }

  let llmProvider: string | undefined;
  let artifactRefs: Array<{ artifactId: string; kind: string; uri: string }> | undefined;
  const autoStartedPhases: string[] = [];
  const autoStartErrors: string[] = [];
  if (shouldCallLlm) {
    const snapshotBeforeLlm = getWorkflowSnapshot(runId);
    if (isPhaseEInduction && action === "RETRY_PHASE" && parsedComponentRefinementPayload) {
      try {
        const currentHtml = resolveOutputHtmlForRefinement(preActionPhaseEOutput);
        const contextArtifact = snapshotBeforeLlm.phases.phase_a?.output?.details?.contextArtifact as
          | { branchFactor?: unknown }
          | undefined;
        const inductionBranchFactor = typeof contextArtifact?.branchFactor === "number"
          ? Math.min(8, Math.max(2, Math.round(contextArtifact.branchFactor)))
          : 2;
        const inductionSpecs = buildInductionSpecs(inductionBranchFactor);
        persistPhaseOutput({
          runId,
          phaseId,
          output: {
            variantId: `phase_e_induction_pending_${Date.now()}`,
            renderMode: "code",
            uiCode: currentHtml
              ? {
                  language: "html",
                  code: currentHtml,
                  sanitized: true,
                }
              : undefined,
            uiSchema: preActionPhaseEOutput?.uiSchema ?? fallbackSchema(phaseId),
            diff: `Launching ${inductionSpecs.length} induction worker(s) for '${parsedComponentRefinementPayload.componentSelector}'.`,
            rubricResults: [
              {
                criterion: "Induction worker startup",
                score: 5,
                maxScore: 5,
                note: "Refinement workers launched and awaiting outputs",
              },
            ],
            details: {
              source: "phase_e_component_induction_pending",
              componentSelector: parsedComponentRefinementPayload.componentSelector,
              refinementPrompt: parsedComponentRefinementPayload.refinementPrompt,
              generatedRefinements: inductionSpecs.map((spec) => ({
                variantId: spec.variantId,
                label: spec.label,
                status: "RUNNING",
              })),
            },
          },
          artifactPayloads: [],
        });

        const refinementResults = await callLlmBatch({
          items: inductionSpecs.map((spec) => ({
            key: spec.variantId,
            runId,
            phaseId,
            prompt: buildComponentRefinementPrompt({
              runId,
              componentSelector: parsedComponentRefinementPayload.componentSelector,
              refinementPrompt: parsedComponentRefinementPayload.refinementPrompt,
              currentHtml,
              branchLabel: spec.label,
              branchIndex: spec.index,
              branchTotal: spec.total,
              branchIntensity: spec.intensity,
            }),
          })),
        });

        const successfulRefinements: Array<{
          variantId: string;
          label: string;
          provider: string;
          status: "APPROVED";
          output: PhaseOutput;
        }> = [];
        const failedRefinements: Array<{
          variantId: string;
          label: string;
          provider: string;
          status: "ERROR_STATUS";
          output: PhaseOutput;
        }> = [];
        refinementResults.forEach((result) => {
          const spec = inductionSpecs.find((candidate) => candidate.variantId === result.key);
          if (!spec) return;
          if (result.status === "SUCCESS") {
            const structured = parseStructuredOutput(result.content ?? "", spec.variantId);
            const output: PhaseOutput = {
              variantId: spec.variantId,
              renderMode: structured.renderMode,
              uiSchema: structured.uiSchema,
              uiCode: structured.uiCode,
              diff: structured.diff,
              rubricResults: structured.rubricResults,
              details: {
                provider: result.provider,
                generatedAt: new Date().toISOString(),
                rawLlmResponse: result.content ?? "",
                source: "phase_e_component_induction_branch",
                componentSelector: parsedComponentRefinementPayload.componentSelector,
                refinementPrompt: parsedComponentRefinementPayload.refinementPrompt,
                scopedRefinement: true,
                inductionBranchIndex: spec.index,
                inductionBranchTotal: spec.total,
                inductionBranchIntensity: spec.intensity,
              },
            };
            successfulRefinements.push({
              variantId: spec.variantId,
              label: spec.label,
              provider: result.provider ?? "llm",
              status: "APPROVED",
              output,
            });
            return;
          }
          const message = result.error ?? "Unknown refinement failure";
          autoStartErrors.push(`${spec.variantId}: ${message}`);
          failedRefinements.push({
            variantId: spec.variantId,
            label: spec.label,
            provider: "llm",
            status: "ERROR_STATUS",
            output: {
              variantId: spec.variantId,
              renderMode: "code",
              uiCode: currentHtml
                ? {
                    language: "html",
                    code: currentHtml,
                    sanitized: true,
                  }
                : undefined,
              uiSchema: preActionPhaseEOutput?.uiSchema ?? fallbackSchema(spec.variantId),
              diff: `Scoped refinement failed for ${parsedComponentRefinementPayload.componentSelector}: ${message}`,
              rubricResults: [
                {
                  criterion: "Scoped induction refinement",
                  score: 1,
                  maxScore: 5,
                  note: message,
                },
              ],
              details: {
                source: "phase_e_component_induction_error",
                componentSelector: parsedComponentRefinementPayload.componentSelector,
                refinementPrompt: parsedComponentRefinementPayload.refinementPrompt,
              },
            },
          });
        });

        if (successfulRefinements.length === 0) {
          return NextResponse.json(
            {
              accepted: false,
              runId,
              phaseId,
              status: "ERROR_STATUS",
              message: "All induction refinement branches failed",
            },
            { status: 502, headers: { "x-contract-version": getContractVersion() } },
          );
        }

        llmProvider = successfulRefinements[0].provider;
        const primary = successfulRefinements[0];
        const generatedRefinements: Array<{
          variantId: string;
          label: string;
          status: "APPROVED" | "ERROR_STATUS";
          provider: string;
          output: PhaseOutput;
        }> = [
          ...successfulRefinements.map((item) => ({
            variantId: item.variantId,
            label: item.label,
            status: item.status,
            provider: item.provider,
            output: item.output,
          })),
          ...failedRefinements.map((item) => ({
            variantId: item.variantId,
            label: item.label,
            status: item.status,
            provider: item.provider,
            output: item.output,
          })),
        ];
        const output: PhaseOutput = {
          ...primary.output,
          variantId: `phase_e_refined_${Date.now()}`,
          details: {
            ...primary.output.details,
            source: "phase_e_component_induction",
            componentSelector: parsedComponentRefinementPayload.componentSelector,
            refinementPrompt: parsedComponentRefinementPayload.refinementPrompt,
            scopedRefinement: true,
            generatedRefinements,
          },
        };

        artifactRefs = persistPhaseOutput({
          runId,
          phaseId,
          output,
          artifactPayloads: [
            { kind: "json", data: { uiSchema: output.uiSchema } },
            ...(output.uiCode ? [{ kind: "json" as const, data: { uiCode: output.uiCode } }] : []),
            { kind: "diff", data: { diff: output.diff } },
            { kind: "rubric", data: { rubricResults: output.rubricResults } },
            { kind: "json", data: { output } },
          ],
        });

        actionResult = markPhaseCompleted({
          runId,
          phaseId,
          actorId: actorId,
          reason: `Component refinement completed for '${parsedComponentRefinementPayload.componentSelector}'`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown LLM execution failure";
        return NextResponse.json(
          { accepted: false, runId, phaseId, status: "ERROR_STATUS", message },
          { status: 502, headers: { "x-contract-version": getContractVersion() } },
        );
      }
    } else {
    const userPrompt =
      typeof body.payload?.prompt === "string" && body.payload.prompt.trim().length > 0
        ? body.payload.prompt.trim()
        : undefined;
    const prompt = isPhaseAContextInit
      ? buildStructuredOutputPrompt(
          phaseId,
          runId,
          parsedContextPayload ?? { intent: "Retry context initialization." },
        )
      : isPhaseEInduction && action === "RETRY_PHASE"
        ? (() => {
            const currentHtml = snapshotBeforeLlm.phases.phase_e?.output?.uiCode?.code ?? "";
            const refinement = parsedComponentRefinementPayload;
            if (!refinement) return "";
            return buildComponentRefinementPrompt({
              runId,
              componentSelector: refinement.componentSelector,
              refinementPrompt: refinement.refinementPrompt,
              currentHtml,
            });
          })()
        : [buildStructuredOutputPrompt(phaseId, runId), userPrompt].filter(Boolean).join("\n\n");
    try {
      const llmResult = await callLlmForPhase({
        runId,
        phaseId,
        prompt,
        debugContext: isPhaseAContextInit
          ? {
              source: "phase_a_context_init",
              intent: parsedContextPayload?.intent ?? "",
              tokens: parsedContextPayload?.tokens ?? "",
              rubric: parsedContextPayload?.rubric ?? "",
              branchFactor: parsedContextPayload?.branchFactor ?? null,
            }
          : {
              source: "workflow_phase_execution",
              phaseId,
            },
      });
      llmProvider = llmResult.provider;
      const structured = parseStructuredOutput(llmResult.content, phaseId);

      const output: PhaseOutput = {
        variantId: `${phaseId}_variant_${Date.now()}`,
        renderMode: structured.renderMode,
        uiSchema: structured.uiSchema,
        uiCode: structured.uiCode,
        diff: structured.diff,
        rubricResults: structured.rubricResults,
        details: {
          provider: llmResult.provider,
          generatedAt: new Date().toISOString(),
          rawLlmResponse: llmResult.content,
        },
      };

      if (isPhaseAContextInit) {
        output.variantId = "context_v0";
        output.details = {
          ...output.details,
          contextArtifact: parsedContextPayload ?? body.payload ?? {},
        };
      } else if (isPhaseEInduction && action === "RETRY_PHASE") {
        output.variantId = `phase_e_refined_${Date.now()}`;
        output.details = {
          ...output.details,
          source: "phase_e_component_induction",
          componentSelector: parsedComponentRefinementPayload?.componentSelector,
          refinementPrompt: parsedComponentRefinementPayload?.refinementPrompt,
          scopedRefinement: true,
        };
      }

      artifactRefs = persistPhaseOutput({
        runId,
        phaseId,
        output,
        artifactPayloads: [
          ...(isPhaseAContextInit
            ? [{ kind: "json" as const, data: { contextArtifact: parsedContextPayload ?? body.payload ?? {} } }]
            : []),
          { kind: "json", data: { uiSchema: output.uiSchema } },
          ...(output.uiCode ? [{ kind: "json" as const, data: { uiCode: output.uiCode } }] : []),
          { kind: "diff", data: { diff: output.diff } },
          { kind: "rubric", data: { rubricResults: output.rubricResults } },
          { kind: "json", data: { output } },
        ],
      });

      if (isPhaseAContextInit && action === "START_PHASE") {
        actionResult = applyWorkflowAction({
          action: "APPROVE_PHASE",
          actorId: actorId,
          phaseId,
          reason: "Phase A context captured and normalized via LLM",
          runId,
        });

        const contextForPermutations = parsedContextPayload ?? { intent: "Generate UI permutations." };
        const permutationSpecs = buildPermutationSpecs(contextForPermutations.branchFactor ?? 2);
        persistPhaseOutput({
          runId,
          phaseId: "phase_d",
          output: {
            variantId: `phase_d_compare_pending_${Date.now()}`,
            renderMode: "schema",
            uiSchema: fallbackSchema("phase_d"),
            diff: `Launching ${permutationSpecs.length} variant worker(s) in parallel...`,
            rubricResults: [
              {
                criterion: "Variant worker startup",
                score: 5,
                maxScore: 5,
                note: "Workers launched and awaiting outputs",
              },
            ],
            details: {
              source: "auto_phase_a_variant_collection_pending",
              generatedVariants: permutationSpecs.map((spec) => ({
                variantId: spec.variantId,
                label: spec.label,
                status: "RUNNING",
              })),
            },
          },
          artifactPayloads: [],
        });
        const permutationResults = await callLlmBatch({
          items: permutationSpecs.map((permutation) => ({
            key: permutation.variantId,
            runId,
            phaseId: permutation.phaseId ?? "phase_d",
            prompt: buildPermutationPrompt(
              permutation.phaseId ?? "phase_d",
              runId,
              contextForPermutations,
              permutation,
            ),
          })),
        });

        const generatedVariants: Array<{
          variantId: string;
          label: string;
          provider: string;
          status: "APPROVED" | "ERROR_STATUS";
          output: PhaseOutput;
        }> = [];

        permutationResults.forEach((result) => {
          const permutation = permutationSpecs.find((candidate) => candidate.variantId === result.key);
          if (!permutation) return;
          if (result.status === "SUCCESS") {
            const structured = parseStructuredOutput(result.content ?? "", permutation.variantId);
            const output: PhaseOutput = {
              variantId: permutation.variantId,
              renderMode: structured.renderMode,
              uiSchema: structured.uiSchema,
              uiCode: structured.uiCode,
              diff: structured.diff,
              rubricResults: structured.rubricResults,
              details: {
                provider: result.provider,
                generatedAt: new Date().toISOString(),
                rawLlmResponse: result.content ?? "",
                permutationMode: permutation.intensity <= 0.5 ? "darker" : "lighter",
                permutationIntensity: permutation.intensity,
                permutationIndex: permutation.index,
                permutationTotal: permutation.total,
                source: permutation.phaseId
                  ? "auto_phase_a_permutation"
                  : "auto_phase_a_permutation_detached",
              },
            };

            if (permutation.phaseId) {
              applyWorkflowAction({
                action: "START_PHASE",
                actorId: actorId,
                phaseId: permutation.phaseId,
                runId,
              });
              persistPhaseOutput({
                runId,
                phaseId: permutation.phaseId,
                output,
                artifactPayloads: [
                  { kind: "json", data: { uiSchema: output.uiSchema } },
                  ...(output.uiCode ? [{ kind: "json" as const, data: { uiCode: output.uiCode } }] : []),
                  { kind: "diff", data: { diff: output.diff } },
                  { kind: "rubric", data: { rubricResults: output.rubricResults } },
                  { kind: "json", data: { output } },
                ],
              });
              applyWorkflowAction({
                action: "APPROVE_PHASE",
                actorId: actorId,
                phaseId: permutation.phaseId,
                reason: "Auto-approved permutation output; human review is deferred to phase_d",
                runId,
              });
              autoStartedPhases.push(permutation.phaseId);
            }

            generatedVariants.push({
              variantId: permutation.variantId,
              label: permutation.label,
              provider: result.provider ?? "llm",
              status: "APPROVED",
              output,
            });
            return;
          }
          const message = result.error ?? "Unknown permutation failure";
          autoStartErrors.push(`${permutation.variantId}: ${message}`);
          generatedVariants.push({
            variantId: permutation.variantId,
            label: permutation.label,
            provider: "llm",
            status: "ERROR_STATUS",
            output: {
              variantId: permutation.variantId,
              renderMode: "schema",
              uiSchema: fallbackSchema(permutation.variantId),
              diff: `Variant generation failed: ${message}`,
              rubricResults: [
                {
                  criterion: "Variant generation",
                  score: 1,
                  maxScore: 5,
                  note: message,
                },
              ],
              details: {
                source: "auto_phase_a_permutation_error",
              },
            },
          });
        });

        if (generatedVariants.length > 0) {
          persistPhaseOutput({
            runId,
            phaseId: "phase_d",
            output: {
              variantId: `phase_d_compare_${Date.now()}`,
              renderMode: "schema",
              uiSchema: fallbackSchema("phase_d"),
              diff: `Generated ${generatedVariants.length} variant(s) for merge review.`,
              rubricResults: [
                {
                  criterion: "Variant coverage",
                  score: generatedVariants.length >= 2 ? 5 : 3,
                  maxScore: 5,
                  note: "Preloaded variant candidates before human merge",
                },
              ],
              details: {
                source: "auto_phase_a_variant_collection",
                generatedVariants: generatedVariants.map((variant) => ({
                  variantId: variant.variantId,
                  label: variant.label,
                  status: variant.status,
                  provider: variant.provider,
                  output: variant.output,
                })),
              },
            },
            artifactPayloads: [
              { kind: "json", data: { generatedVariants: generatedVariants.map((variant) => ({
                variantId: variant.variantId,
                label: variant.label,
                status: variant.status,
                provider: variant.provider,
                output: variant.output,
              })) } },
            ],
          });
        }
      }

      if (!isPhaseAContextInit && (action === "START_PHASE" || action === "RETRY_PHASE")) {
        if (!actionResult) {
          actionResult = applyWorkflowAction({
            action,
            actorId: actorId,
            payload: body.payload,
            phaseId,
            reason: body.reason,
            runId,
          });
        }
        if (phaseId === "phase_b" || phaseId === "phase_c") {
          actionResult = applyWorkflowAction({
            action: "APPROVE_PHASE",
            actorId: actorId,
            phaseId,
            reason: `${phaseId} auto-approved; review is only required for phase_d`,
            runId,
          });
        } else if (phaseId === "phase_e" && !actionResult) {
          actionResult = markPhaseCompleted({
            runId,
            phaseId,
            actorId: actorId,
            reason: parsedComponentRefinementPayload
              ? `Component refinement completed for '${parsedComponentRefinementPayload.componentSelector}'`
              : body.reason ?? "Final merge refinement completed",
          });
        } else {
          actionResult = applyWorkflowAction({
            action: "APPROVE_PHASE",
            actorId: actorId,
            phaseId,
            reason: body.reason ?? "LLM phase completed",
            runId,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown LLM execution failure";
      return NextResponse.json(
        { accepted: false, runId, phaseId, status: "ERROR_STATUS", message },
        { status: 502, headers: { "x-contract-version": getContractVersion() } },
      );
    }
    }
  }

  if (!actionResult) {
    if (isPhaseEInductionMergeAction) {
      try {
        const snapshot = getWorkflowSnapshot(runId);
        const refinements = snapshot.phases.phase_e?.output?.details?.generatedRefinements;
        const selected = Array.isArray(refinements)
          ? refinements.find((entry) => {
              if (!entry || typeof entry !== "object") return false;
              const candidate = entry as Record<string, unknown>;
              return candidate.variantId === parsedInductionMergePayload?.selectedVariantId;
            })
          : undefined;
        if (!selected || typeof selected !== "object") {
          return NextResponse.json(
            {
              accepted: false,
              runId,
              phaseId,
              status: "ERROR_STATUS",
              message: `Induction merge variant '${parsedInductionMergePayload?.selectedVariantId ?? ""}' not found`,
            },
            { status: 400, headers: { "x-contract-version": getContractVersion() } },
          );
        }
        const selectedOutput = (selected as Record<string, unknown>).output;
        if (!selectedOutput || typeof selectedOutput !== "object") {
          return NextResponse.json(
            {
              accepted: false,
              runId,
              phaseId,
              status: "ERROR_STATUS",
              message: "Selected induction variant has no output payload",
            },
            { status: 400, headers: { "x-contract-version": getContractVersion() } },
          );
        }

        applyWorkflowAction({
          action: "START_PHASE",
          actorId: actorId,
          payload: body.payload,
          phaseId,
          reason: body.reason ?? "Starting induction merge",
          runId,
        });

        const selectedPhaseOutput = selectedOutput as PhaseOutput;
        const mergedOutput: PhaseOutput = {
          ...selectedPhaseOutput,
          variantId: `phase_e_induction_merged_${Date.now()}`,
          details: {
            ...(selectedPhaseOutput.details ?? {}),
            source: "phase_e_induction_merge",
            inductionMerge: {
              selectedVariantId: parsedInductionMergePayload?.selectedVariantId,
              mergeRationale: parsedInductionMergePayload?.mergeRationale,
              mergedAt: new Date().toISOString(),
            },
            generatedRefinements: Array.isArray(refinements) ? refinements : [],
          },
        };

        artifactRefs = persistPhaseOutput({
          runId,
          phaseId,
          output: mergedOutput,
          artifactPayloads: [
            { kind: "json", data: { uiSchema: mergedOutput.uiSchema } },
            ...(mergedOutput.uiCode ? [{ kind: "json" as const, data: { uiCode: mergedOutput.uiCode } }] : []),
            { kind: "diff", data: { diff: mergedOutput.diff } },
            { kind: "rubric", data: { rubricResults: mergedOutput.rubricResults } },
            { kind: "json", data: { output: mergedOutput } },
          ],
        });

        actionResult = markPhaseCompleted({
          runId,
          phaseId,
          actorId: actorId,
          reason: parsedInductionMergePayload?.mergeRationale
            ? `Induction merge selected '${parsedInductionMergePayload.selectedVariantId}': ${parsedInductionMergePayload.mergeRationale}`
            : `Induction merge selected '${parsedInductionMergePayload?.selectedVariantId ?? ""}'`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown action failure";
        return NextResponse.json(
          { accepted: false, runId, phaseId, status: "ERROR_STATUS", message },
          { status: 404, headers: { "x-contract-version": getContractVersion() } },
        );
      }
    } else
    if (isPhaseDMergeReview && action === "START_PHASE") {
      try {
        applyWorkflowAction({
          action: "START_PHASE",
          actorId: actorId,
          payload: body.payload,
          phaseId,
          reason: body.reason,
          runId,
        });

        const snapshot = getWorkflowSnapshot(runId);
        const existingGeneratedVariants = snapshot.phases.phase_d?.output?.details?.generatedVariants;
        const variantsForMerge: Array<{ variantId: string; label: string; output?: PhaseOutput }> = [];
        if (Array.isArray(existingGeneratedVariants)) {
          for (const entry of existingGeneratedVariants) {
            if (!entry || typeof entry !== "object") continue;
            const candidate = entry as Record<string, unknown>;
            const variantId = typeof candidate.variantId === "string" ? candidate.variantId : undefined;
            if (!variantId) continue;
            variantsForMerge.push({
              variantId,
              label: typeof candidate.label === "string" ? candidate.label : variantId,
              output: candidate.output && typeof candidate.output === "object"
                ? (candidate.output as PhaseOutput)
                : undefined,
            });
          }
        }
        if (variantsForMerge.length === 0) {
          variantsForMerge.push(
            {
              variantId: "phase_b",
              label: "Variant B",
              output: snapshot.phases.phase_b?.output,
            },
            {
              variantId: "phase_c",
              label: "Variant C",
              output: snapshot.phases.phase_c?.output,
            },
          );
        }
        const explicitVariantIds = (parsedMergeReviewPayload?.selectedVariantIds ?? [])
          .filter((variantId, index, all) => all.indexOf(variantId) === index)
          .filter((variantId) => variantsForMerge.some((variant) => variant.variantId === variantId));
        const preferredVariantIds = explicitVariantIds.length > 0
          ? explicitVariantIds
          : inferPreferredVariantIds(
              variantsForMerge,
              parsedMergeReviewPayload?.mergerExplanation ?? "",
            );

        const mergeReviewOutput: PhaseOutput = {
          variantId: `phase_d_merge_${Date.now()}`,
          diff: `Human merger rationale: ${parsedMergeReviewPayload?.mergerExplanation ?? ""}`,
          rubricResults: [
            {
              criterion: "Human merger rationale provided",
              score: 5,
              maxScore: 5,
              note: "Phase D completed from explicit human input",
            },
          ],
          details: {
            mergerExplanation: parsedMergeReviewPayload?.mergerExplanation ?? "",
            splitNodeHint: parsedMergeReviewPayload?.splitNodeHint,
            source: "human_merge_review",
            preferredVariantIds,
            selectedVariantIds: explicitVariantIds,
            generatedVariants: Array.isArray(existingGeneratedVariants) ? existingGeneratedVariants : undefined,
          },
        };

        artifactRefs = persistPhaseOutput({
          runId,
          phaseId,
          output: mergeReviewOutput,
          artifactPayloads: [
            { kind: "json", data: { output: mergeReviewOutput } },
            { kind: "diff", data: { diff: mergeReviewOutput.diff } },
            { kind: "rubric", data: { rubricResults: mergeReviewOutput.rubricResults } },
          ],
        });

        actionResult = applyWorkflowAction({
          action: "APPROVE_PHASE",
          actorId: actorId,
          phaseId,
          reason: "Human merge explanation submitted",
          runId,
        });

        // Phase E (merge/finalize) should start by default as soon as D is submitted.
        const nextPhaseId = "phase_e";
        const phaseEStart = applyWorkflowAction({
          action: "START_PHASE",
          actorId: actorId,
          phaseId: nextPhaseId,
          reason: "Auto-started after phase_d submission",
          runId,
        });
        autoStartedPhases.push(nextPhaseId);
        const phaseEStartUpdate =
          phaseEStart.event.eventType === "phase_updated" ? phaseEStart.event.phase : undefined;
        console.info("[workflow] auto-started phase_e", {
          runId,
          previousStatus: phaseEStartUpdate?.previousStatus,
          nextStatus: phaseEStartUpdate?.status,
        });

        const snapshotAfterEStart = getWorkflowSnapshot(runId);
        const availableVariants = variantsForMerge.filter((variant) => variant.output);
        const preferredPrimary = availableVariants.find((variant) =>
          preferredVariantIds.includes(variant.variantId),
        );
        const mergedBaseOutput = preferredPrimary?.output
          ?? availableVariants[0]?.output
          ?? snapshotAfterEStart.phases.phase_b?.output
          ?? snapshotAfterEStart.phases.phase_c?.output;
        const fallbackFinalSchema = fallbackSchema(nextPhaseId);
        let finalPhaseOutput: PhaseOutput;
        try {
          const llmMergePrompt = buildFinalMergePrompt({
            runId,
            mergerExplanation: parsedMergeReviewPayload?.mergerExplanation ?? "",
            splitNodeHint: parsedMergeReviewPayload?.splitNodeHint,
            variants: variantsForMerge,
            preferredVariantIds,
          });
          const llmMergeResult = await callLlmForPhase({
            runId,
            phaseId: nextPhaseId,
            prompt: llmMergePrompt,
          });
          const structuredMerge = parseStructuredOutput(llmMergeResult.content, nextPhaseId);
          finalPhaseOutput = {
            variantId: `phase_e_final_${Date.now()}`,
            renderMode: structuredMerge.renderMode,
            uiSchema: structuredMerge.uiSchema,
            uiCode: structuredMerge.uiCode,
            diff: structuredMerge.diff,
            rubricResults: structuredMerge.rubricResults,
            details: {
              provider: llmMergeResult.provider,
              generatedAt: new Date().toISOString(),
              rawLlmResponse: llmMergeResult.content,
              source: "auto_phase_e_finalize_llm_merge",
              fromPhases: variantsForMerge.map((variant) => variant.variantId),
              mergerExplanation: parsedMergeReviewPayload?.mergerExplanation ?? "",
              splitNodeHint: parsedMergeReviewPayload?.splitNodeHint,
              preferredVariantIds,
            },
          };
        } catch (llmMergeError) {
          const mergeErrorMessage = llmMergeError instanceof Error ? llmMergeError.message : "Unknown merge failure";
          autoStartErrors.push(`phase_e_merge: ${mergeErrorMessage}`);
          finalPhaseOutput = {
            variantId: `phase_e_final_${Date.now()}`,
            renderMode: mergedBaseOutput?.uiCode ? (mergedBaseOutput.renderMode ?? "code") : "schema",
            uiSchema: mergedBaseOutput?.uiSchema ?? fallbackFinalSchema,
            uiCode: mergedBaseOutput?.uiCode,
            diff: [
              "Final merge fallback used after LLM merge failure.",
              `Human rationale: ${parsedMergeReviewPayload?.mergerExplanation ?? ""}`,
              `Preferred variants: ${preferredVariantIds.join(", ") || "none detected"}`,
              `Merge error: ${mergeErrorMessage}`,
            ].join("\n"),
            rubricResults: mergedBaseOutput?.rubricResults ?? [
              {
                criterion: "Final merge consistency",
                score: 3,
                maxScore: 5,
                note: "Fallback merge applied due to LLM merge failure",
              },
            ],
            details: {
              source: "auto_phase_e_finalize_fallback",
              fromPhases: variantsForMerge.map((variant) => variant.variantId),
              mergerExplanation: parsedMergeReviewPayload?.mergerExplanation ?? "",
              splitNodeHint: parsedMergeReviewPayload?.splitNodeHint,
              preferredVariantIds,
            },
          };
        }

        persistPhaseOutput({
          runId,
          phaseId: nextPhaseId,
          output: finalPhaseOutput,
          artifactPayloads: [
            ...(finalPhaseOutput.uiSchema ? [{ kind: "json" as const, data: { uiSchema: finalPhaseOutput.uiSchema } }] : []),
            ...(finalPhaseOutput.uiCode ? [{ kind: "json" as const, data: { uiCode: finalPhaseOutput.uiCode } }] : []),
            { kind: "diff", data: { diff: finalPhaseOutput.diff } },
            { kind: "rubric", data: { rubricResults: finalPhaseOutput.rubricResults } },
            { kind: "json", data: { output: finalPhaseOutput } },
          ],
        });

        const phaseEComplete = markPhaseCompleted({
          runId,
          phaseId: nextPhaseId,
          actorId: actorId,
          reason: "Auto-finalized after phase_d submission",
        });
        const phaseECompleteUpdate =
          phaseEComplete.event.eventType === "phase_updated" ? phaseEComplete.event.phase : undefined;
        console.info("[workflow] auto-completed phase_e", {
          runId,
          previousStatus: phaseECompleteUpdate?.previousStatus,
          nextStatus: phaseECompleteUpdate?.status,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown action failure";
        return NextResponse.json(
          { accepted: false, runId, phaseId, status: "ERROR_STATUS", message },
          { status: 404, headers: { "x-contract-version": getContractVersion() } },
        );
      }
    } else {
    try {
      actionResult = applyWorkflowAction({
        action,
        actorId: actorId,
        payload: body.payload,
        phaseId,
        reason: body.reason,
        runId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown action failure";
      return NextResponse.json(
        { accepted: false, runId, phaseId, status: "ERROR_STATUS", message },
        { status: 404, headers: { "x-contract-version": getContractVersion() } },
      );
    }
    }
  }

  return NextResponse.json(
    {
      ...actionResult.response,
      event: actionResult.event,
      llmProvider,
      artifacts: artifactRefs,
      autoStartedPhases: autoStartedPhases.length > 0 ? autoStartedPhases : undefined,
      autoStartErrors: autoStartErrors.length > 0 ? autoStartErrors : undefined,
    },
    { headers: { "x-contract-version": getContractVersion() } },
  );
}
