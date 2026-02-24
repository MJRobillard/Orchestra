"use client";

import { useState } from "react";
import type { WorkflowActionType } from "@/contracts/workflow-contract";

export interface ContextInitPayload {
  /** High-level description of the UI/UX change the human wants to make. */
  intent: string;
  /** Design tokens, colour palette, spacing rules, component constraints. */
  tokens?: string;
  /** Evaluation criteria the LLM variants will be scored against. */
  rubric?: string;
  /** Number of branches/variants to generate. */
  branchFactor?: number;
}

interface ContextInitFormProps {
  dispatch: (
    action: WorkflowActionType,
    reason?: string,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
  loading: boolean;
  error: string | null;
  branchFactor: number;
}

const TEXTAREA_CLASS =
  "w-full resize-none rounded bg-slate-800 px-3 py-2 font-mono text-xs text-slate-200 " +
  "placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-slate-600 " +
  "disabled:opacity-50";

/**
 * Phase A — Human Context Initialization form.
 *
 * The human authors the canonical context (intent + tokens + rubric) that gates
 * all downstream LLM variant phases. Submitting calls START_PHASE with the
 * structured payload attached so the backend can persist it as a ContextArtifact.
 */
export function ContextInitForm({ dispatch, loading, error, branchFactor }: ContextInitFormProps) {
  const [intent, setIntent] = useState("");
  const [tokens, setTokens] = useState("");
  const [rubric, setRubric] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Build only the fields the human filled in — omit empty optionals so the
    // backend payload stays clean and the JSON artifact is self-documenting.
    const payload: ContextInitPayload = { intent: intent.trim() };
    if (tokens.trim()) payload.tokens = tokens.trim();
    if (rubric.trim()) payload.rubric = rubric.trim();
    payload.branchFactor = branchFactor;

    await dispatch("START_PHASE", undefined, payload as unknown as Record<string, unknown>);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4"
      data-testid="context-init-form"
    >
      {/* UI/UX Intent ─ required */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="ctx-intent"
          className="text-[10px] font-medium uppercase tracking-wider text-slate-500"
        >
          UI/UX Intent <span className="text-slate-600">(required)</span>
        </label>
        <textarea
          id="ctx-intent"
          data-testid="ctx-intent"
          required
          rows={4}
          disabled={loading}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          placeholder={"Describe the UI/UX change you want to make.\n\ne.g. Redesign the onboarding modal so it collects email + role in two steps instead of one long form."}
          className={TEXTAREA_CLASS}
        />
      </div>

      {/* Design tokens & constraints ─ optional */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="ctx-tokens"
          className="text-[10px] font-medium uppercase tracking-wider text-slate-500"
        >
          Design Tokens & Constraints{" "}
          <span className="text-slate-600">(optional)</span>
        </label>
        <textarea
          id="ctx-tokens"
          data-testid="ctx-tokens"
          rows={3}
          disabled={loading}
          value={tokens}
          onChange={(e) => setTokens(e.target.value)}
          placeholder={"primary: #3B82F6\nradius: 8px\nspacing: 4px grid\nFont: Inter 14/1.5"}
          className={TEXTAREA_CLASS}
        />
      </div>

      {/* Evaluation rubric ─ optional */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="ctx-rubric"
          className="text-[10px] font-medium uppercase tracking-wider text-slate-500"
        >
          Evaluation Rubric{" "}
          <span className="text-slate-600">(optional)</span>
        </label>
        <textarea
          id="ctx-rubric"
          data-testid="ctx-rubric"
          rows={3}
          disabled={loading}
          value={rubric}
          onChange={(e) => setRubric(e.target.value)}
          placeholder={"- WCAG 2.1 AA contrast\n- Matches design system tokens\n- < 2 s LCP on mobile\n- No layout shift"}
          className={TEXTAREA_CLASS}
        />
      </div>

      {/* Inline error */}
      {error && (
        <p className="rounded bg-red-950 px-2 py-1 font-mono text-[10px] text-red-400">
          {error}
        </p>
      )}

      {/* Submit */}
      <button
        type="submit"
        data-testid="ctx-submit"
        disabled={loading || !intent.trim()}
        className={
          "rounded px-3 py-2 text-sm font-medium text-white transition-colors " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 " +
          "focus-visible:ring-offset-1 focus-visible:ring-offset-slate-900 " +
          "disabled:opacity-50 " +
          "bg-violet-600 hover:bg-violet-500 disabled:hover:bg-violet-600"
        }
      >
        {loading ? "Initializing Context + Running Variants..." : "Initialize Context →"}
      </button>
    </form>
  );
}
