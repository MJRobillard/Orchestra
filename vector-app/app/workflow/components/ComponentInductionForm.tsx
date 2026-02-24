"use client";

import { useState } from "react";
import type { WorkflowActionType } from "@/contracts/workflow-contract";

interface ComponentInductionFormProps {
  dispatch: (
    action: WorkflowActionType,
    reason?: string,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
  loading: boolean;
  error: string | null;
}

const INPUT_CLASS =
  "w-full rounded bg-slate-800 px-3 py-2 font-mono text-xs text-slate-200 " +
  "placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-slate-600 disabled:opacity-50";

const TEXTAREA_CLASS =
  "w-full resize-none rounded bg-slate-800 px-3 py-2 font-mono text-xs text-slate-200 " +
  "placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-slate-600 disabled:opacity-50";

export function ComponentInductionForm({ dispatch, loading, error }: ComponentInductionFormProps) {
  const [componentSelector, setComponentSelector] = useState("");
  const [refinementPrompt, setRefinementPrompt] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const selector = componentSelector.trim();
    const prompt = refinementPrompt.trim();
    if (!selector || !prompt) return;
    await dispatch("RETRY_PHASE", undefined, {
      componentSelector: selector,
      refinementPrompt: prompt,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" data-testid="component-induction-form">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="component-selector" className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Component Selector <span className="text-slate-600">(required)</span>
        </label>
        <input
          id="component-selector"
          type="text"
          value={componentSelector}
          disabled={loading}
          onChange={(e) => setComponentSelector(e.target.value)}
          placeholder="e.g. #hero-cta or .pricing-card:nth-child(2)"
          className={INPUT_CLASS}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="component-refinement" className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Refinement Prompt <span className="text-slate-600">(required)</span>
        </label>
        <textarea
          id="component-refinement"
          rows={4}
          value={refinementPrompt}
          disabled={loading}
          onChange={(e) => setRefinementPrompt(e.target.value)}
          placeholder="Refine only this component: increase contrast, simplify spacing, and improve hover state."
          className={TEXTAREA_CLASS}
        />
      </div>

      {error ? (
        <p className="rounded bg-red-950 px-2 py-1 font-mono text-[10px] text-red-400">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={loading || componentSelector.trim().length === 0 || refinementPrompt.trim().length === 0}
        className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50 disabled:hover:bg-emerald-600"
      >
        {loading ? "Refining Component..." : "Run Component Induction"}
      </button>
    </form>
  );
}
