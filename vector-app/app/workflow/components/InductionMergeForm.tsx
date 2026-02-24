"use client";

import { useMemo, useState } from "react";
import type { WorkflowActionType } from "@/contracts/workflow-contract";

interface VariantOption {
  variantId: string;
  label: string;
  status?: string;
  hasOutput?: boolean;
}

interface InductionMergeFormProps {
  dispatch: (
    action: WorkflowActionType,
    reason?: string,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
  loading: boolean;
  error: string | null;
  variants: VariantOption[];
  exportHtml?: string;
}

export function InductionMergeForm({ dispatch, loading, error, variants, exportHtml }: InductionMergeFormProps) {
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [mergeRationale, setMergeRationale] = useState("");
  const selectableVariants = useMemo(
    () => variants.filter((variant) => variant.status !== "ERROR_STATUS" && variant.hasOutput === true),
    [variants],
  );

  function handleExportHtml() {
    if (!exportHtml) return;
    const blob = new Blob([exportHtml], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "merged-output.html";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedVariantId) return;
    await dispatch("START_PHASE", undefined, {
      selectedVariantId,
      ...(mergeRationale.trim() ? { mergeRationale: mergeRationale.trim() } : {}),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" data-testid="induction-merge-form">
      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-medium uppercase tracking-wider text-slate-500" htmlFor="induction-variant">
          Select Induction Variant
        </label>
        <select
          id="induction-variant"
          className="rounded border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200 disabled:opacity-50"
          value={selectedVariantId}
          onChange={(e) => setSelectedVariantId(e.target.value)}
          disabled={loading || selectableVariants.length === 0}
        >
          <option value="">Choose variant...</option>
          {selectableVariants.map((variant) => (
            <option key={variant.variantId} value={variant.variantId}>
              {variant.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-medium uppercase tracking-wider text-slate-500" htmlFor="induction-rationale">
          Merge Rationale (optional)
        </label>
        <textarea
          id="induction-rationale"
          rows={3}
          value={mergeRationale}
          onChange={(e) => setMergeRationale(e.target.value)}
          disabled={loading}
          placeholder="Why this induction variant should become the new base."
          className="w-full resize-none rounded bg-slate-800 px-3 py-2 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-slate-600 disabled:opacity-50"
        />
      </div>

      {error ? (
        <p className="rounded bg-red-950 px-2 py-1 font-mono text-[10px] text-red-400">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={loading || !selectedVariantId}
        className="rounded bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50 disabled:hover:bg-amber-600"
      >
        {loading ? "Merging..." : "Merge Selected Variant"}
      </button>

      <button
        type="button"
        onClick={handleExportHtml}
        disabled={!exportHtml}
        className="rounded border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
      >
        Export HTML
      </button>
    </form>
  );
}
