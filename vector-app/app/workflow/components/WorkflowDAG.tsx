"use client";

import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  BackgroundVariant,
  type Node,
  type NodeTypes,
  type NodeMouseHandler,
} from "@xyflow/react";
import type { WorkflowSnapshot } from "@/contracts/workflow-contract";
import { PhaseNode, type PhaseNodeType } from "./PhaseNode";
import { computeDAGLayout } from "../utils/dag-layout";
import { buildWorkflowGraph } from "../utils/workflow-graph";

const nodeTypes: NodeTypes = { phaseNode: PhaseNode };

interface WorkflowDAGProps {
  snapshot: WorkflowSnapshot;
  selectedPhaseId?: string;
  onSelectPhase: (phaseId: string | null) => void;
}

export function WorkflowDAG({ snapshot, selectedPhaseId, onSelectPhase }: WorkflowDAGProps) {
  const positions = useMemo(() => computeDAGLayout(snapshot.nodes, snapshot.edges), [snapshot.nodes, snapshot.edges]);

  const { nodes, edges } = useMemo(
    () => buildWorkflowGraph(snapshot, positions, selectedPhaseId),
    [snapshot, positions, selectedPhaseId],
  );

  const onNodeClick: NodeMouseHandler<Node> = useCallback(
    (_evt, node: Node) => {
      onSelectPhase(node.id === selectedPhaseId ? null : node.id);
    },
    [onSelectPhase, selectedPhaseId],
  );

  const onPaneClick = useCallback(() => {
    onSelectPhase(null);
  }, [onSelectPhase]);

  return (
    <div className="h-full w-full" data-testid="workflow-dag-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes as NodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.35 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        className="bg-slate-950"
      >
        <Background variant={BackgroundVariant.Dots} color="#1e293b" gap={28} size={1.5} />
        <Controls
          style={{
            background: "rgb(15 23 42)",
            border: "1px solid rgb(51 65 85)",
            borderRadius: "0.5rem",
          }}
        />
      </ReactFlow>
    </div>
  );
}

// Re-export for dynamic import consumption
export type { PhaseNodeType };
