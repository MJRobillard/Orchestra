import type { Edge, Node } from "@xyflow/react";
import type { WorkflowSnapshot } from "@/contracts/workflow-contract";
import type { PhaseNodeData } from "../components/PhaseNode";

export function buildWorkflowGraph(
  snapshot: WorkflowSnapshot,
  positions: Map<string, { x: number; y: number }>,
  selectedPhaseId?: string,
): { nodes: Node<PhaseNodeData>[]; edges: Edge[] } {
  const nodes: Node<PhaseNodeData>[] = snapshot.nodes.map((n) => ({
    id: n.phaseId,
    type: "phaseNode" as const,
    position: positions.get(n.phaseId) ?? { x: 0, y: 0 },
    selected: n.phaseId === selectedPhaseId,
    data: {
      phaseId: n.phaseId,
      label: n.label,
      phaseType: n.phaseType,
      status: n.status,
    },
  }));

  const edges: Edge[] = snapshot.edges.map((e) => ({
    id: `${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    style: { stroke: "#475569", strokeWidth: 1.5 },
    animated: false,
  }));

  return { nodes, edges };
}
