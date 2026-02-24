import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { PhaseStatus, PhaseType } from "@/contracts/workflow-contract";

export interface PhaseNodeData {
  phaseId: string;
  label: string;
  phaseType: PhaseType;
  status: PhaseStatus;
  [key: string]: unknown;
}

export type PhaseNodeType = Node<PhaseNodeData, "phaseNode">;

const STATUS_CONFIG: Record<
  PhaseStatus,
  { border: string; badge: string; dot: string; pulse: boolean }
> = {
  DRAFT: {
    border: "border-slate-600",
    badge: "bg-slate-700 text-slate-300",
    dot: "bg-slate-500",
    pulse: false,
  },
  BLOCKED: {
    border: "border-slate-600",
    badge: "bg-slate-700 text-slate-400",
    dot: "bg-slate-600",
    pulse: false,
  },
  RUNNING: {
    border: "border-blue-500",
    badge: "bg-blue-950 text-blue-300",
    dot: "bg-blue-400",
    pulse: true,
  },
  WAITING_FOR_HUMAN: {
    border: "border-amber-500",
    badge: "bg-amber-950 text-amber-300",
    dot: "bg-amber-400",
    pulse: true,
  },
  READY_FOR_REVIEW: {
    border: "border-orange-400",
    badge: "bg-orange-950 text-orange-300",
    dot: "bg-orange-400",
    pulse: false,
  },
  APPROVED: {
    border: "border-emerald-500",
    badge: "bg-emerald-950 text-emerald-300",
    dot: "bg-emerald-500",
    pulse: false,
  },
  REJECTED: {
    border: "border-red-500",
    badge: "bg-red-950 text-red-300",
    dot: "bg-red-500",
    pulse: false,
  },
  ERROR_STATUS: {
    border: "border-red-700",
    badge: "bg-red-950 text-red-200",
    dot: "bg-red-600",
    pulse: true,
  },
  COMPLETED: {
    border: "border-emerald-700",
    badge: "bg-emerald-950 text-emerald-400",
    dot: "bg-emerald-600",
    pulse: false,
  },
};

const TYPE_LABEL: Record<PhaseType, string> = {
  SYSTEM: "SYS",
  LLM: "LLM",
  HUMAN: "HMN",
};

export function PhaseNode({ data, selected }: NodeProps<PhaseNodeType>) {
  const cfg = STATUS_CONFIG[data.status] ?? STATUS_CONFIG.DRAFT;

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2 !w-2 !border-slate-500 !bg-slate-700"
      />

      <div
        className={[
          "w-[200px] cursor-pointer rounded-lg border bg-slate-900 px-4 py-3",
          "shadow-lg transition-all duration-150",
          cfg.border,
          selected ? "ring-2 ring-white/25 ring-offset-1 ring-offset-slate-950" : "",
        ].join(" ")}
        data-testid={`dag-node-${data.phaseId ?? data.label}`}
        data-status={data.status}
      >
        {/* Top row: type chip + status */}
        <div className="flex items-center justify-between gap-2">
          <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${cfg.badge}`}>
            {TYPE_LABEL[data.phaseType] ?? data.phaseType}
          </span>
          <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${cfg.dot} ${cfg.pulse ? "animate-pulse" : ""}`}
            />
            {data.status.replace(/_/g, " ")}
          </span>
        </div>

        {/* Phase label */}
        <p className="mt-1.5 text-sm font-medium leading-snug text-slate-100">{data.label}</p>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !border-slate-500 !bg-slate-700"
      />
    </>
  );
}
