"use client";

import { useMemo, useState } from "react";
import type { WorkflowActionType } from "@/contracts/workflow-contract";

interface MergeVariantOption {
  variantId: string;
  label: string;
}

interface MergeReviewFormProps {
  dispatch: (
    action: WorkflowActionType,
    reason?: string,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
  loading: boolean;
  error: string | null;
  variants: MergeVariantOption[];
}

const TEXTAREA_CLASS =
  "w-full resize-none rounded bg-slate-800 px-3 py-2 font-mono text-xs text-slate-200 " +
  "placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-slate-600 " +
  "disabled:opacity-50";

export function MergeReviewForm({ dispatch, loading, error, variants }: MergeReviewFormProps) {
  const [mergerExplanation, setMergerExplanation] = useState("");
  const [splitNodeHint, setSplitNodeHint] = useState("");
  const [selectedVariantIds, setSelectedVariantIds] = useState<string[]>([]);
  const selectedCount = useMemo(() => selectedVariantIds.length, [selectedVariantIds]);

  function toggleVariant(variantId: string) {
    setSelectedVariantIds((current) =>
      current.includes(variantId)
        ? current.filter((candidate) => candidate !== variantId)
        : current.concat(variantId),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const explanation = mergerExplanation.trim();
    if (!explanation) return;
    await dispatch("START_PHASE", undefined, {
      mergerExplanation: explanation,
      ...(splitNodeHint.trim() ? { splitNodeHint: splitNodeHint.trim() } : {}),
      ...(selectedVariantIds.length > 0 ? { selectedVariantIds } : {}),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" data-testid="merge-review-form">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="merge-explanation"
          className="text-[10px] font-medium uppercase tracking-wider text-slate-500"
        >
          Merger Explanation <span className="text-slate-600">(required)</span>
        </label>
        <textarea
          id="merge-explanation"
          required
          rows={5}
          disabled={loading}
          value={mergerExplanation}
          onChange={(e) => setMergerExplanation(e.target.value)}
          placeholder="Explain what you are merging from variants B/C and why this final direction is better."
          className={TEXTAREA_CLASS}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Inspiration Variants <span className="text-slate-600">(optional)</span>
        </p>
        {variants.length > 0 ? (
          <div className="space-y-1 rounded bg-slate-800 p-2">
            {variants.map((variant) => (
              <label key={variant.variantId} className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  checked={selectedVariantIds.includes(variant.variantId)}
                  disabled={loading}
                  onChange={() => toggleVariant(variant.variantId)}
                />
                <span>{variant.label}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500">No variants available yet.</p>
        )}
        <p className="text-[10px] text-slate-500">
          {selectedCount > 0
            ? `${selectedCount} variant(s) selected for inspiration`
            : "If none selected, merge will infer from your instruction"}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="split-node-hint"
          className="text-[10px] font-medium uppercase tracking-wider text-slate-500"
        >
          Split Node Focus <span className="text-slate-600">(optional)</span>
        </label>
        <input
          id="split-node-hint"
          type="text"
          disabled={loading}
          value={splitNodeHint}
          onChange={(e) => setSplitNodeHint(e.target.value)}
          placeholder="e.g. hero.cta.button"
          className="w-full rounded bg-slate-800 px-3 py-2 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-slate-600 disabled:opacity-50"
        />
      </div>

      {error ? (
        <p className="rounded bg-red-950 px-2 py-1 font-mono text-[10px] text-red-400">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={loading || mergerExplanation.trim().length === 0}
        className={
          "rounded px-3 py-2 text-sm font-medium text-white transition-colors " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 " +
          "focus-visible:ring-offset-1 focus-visible:ring-offset-slate-900 " +
          "disabled:opacity-50 bg-sky-600 hover:bg-sky-500 disabled:hover:bg-sky-600"
        }
      >
        {loading ? "Submitting Merge Review..." : "Submit Merge Review"}
      </button>
    </form>
  );
}
