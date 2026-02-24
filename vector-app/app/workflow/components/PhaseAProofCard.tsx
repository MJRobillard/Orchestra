"use client";

interface PhaseAProofCardProps {
  contextArtifact: {
    intent?: string;
    tokens?: string;
    rubric?: string;
  };
  generatedBrief?: string;
}

const BLOCK_CLASS =
  "rounded bg-slate-800 px-2.5 py-2 font-mono text-[10px] text-slate-300 whitespace-pre-wrap break-words";

export function PhaseAProofCard({ contextArtifact, generatedBrief }: PhaseAProofCardProps) {
  return (
    <div className="flex flex-col gap-2 rounded border border-slate-700 bg-slate-900/60 p-3">
      <p className="text-[10px] uppercase tracking-wider text-slate-500">Phase A Proof of Concept</p>
      <p className="text-xs text-slate-400">
        Human context is captured and sent to the LLM to generate a normalized implementation brief.
      </p>

      <div className="flex flex-col gap-1">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">Intent</p>
        <div className={BLOCK_CLASS}>{contextArtifact.intent ?? "(not provided)"}</div>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">Tokens</p>
        <div className={BLOCK_CLASS}>{contextArtifact.tokens ?? "(not provided)"}</div>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">Rubric</p>
        <div className={BLOCK_CLASS}>{contextArtifact.rubric ?? "(not provided)"}</div>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">LLM Brief</p>
        <div className={BLOCK_CLASS}>{generatedBrief?.trim() || "(no brief generated yet)"}</div>
      </div>
    </div>
  );
}
