import type { WorkflowNode, WorkflowEdge } from "@/contracts/workflow-contract";

export interface NodePosition {
  x: number;
  y: number;
}

const NODE_W = 200;
const NODE_H = 72;
const H_GAP = 80;
const V_GAP = 100;

/**
 * Computes a layered (Sugiyama-style) layout from DAG nodes and edges.
 * Each node is assigned the longest path from a root, ensuring parents
 * always appear above children.
 */
export function computeDAGLayout(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Map<string, NodePosition> {
  // Build forward adjacency and in-degree map
  const children = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const n of nodes) {
    children.set(n.phaseId, []);
    inDegree.set(n.phaseId, 0);
  }

  for (const e of edges) {
    children.get(e.from)?.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  // Longest-path layering via BFS (guarantees no child above parent)
  const layer = new Map<string, number>();
  const queue: string[] = [];

  for (const n of nodes) {
    if ((inDegree.get(n.phaseId) ?? 0) === 0) {
      layer.set(n.phaseId, 0);
      queue.push(n.phaseId);
    }
  }

  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    const curLayer = layer.get(cur) ?? 0;
    for (const next of children.get(cur) ?? []) {
      const proposed = curLayer + 1;
      if ((layer.get(next) ?? -1) < proposed) {
        layer.set(next, proposed);
        queue.push(next);
      }
    }
  }

  // Group nodes by layer, preserving original order within each layer
  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.phaseId) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n.phaseId);
  }

  // Assign (x, y) — center each layer horizontally
  const positions = new Map<string, NodePosition>();

  for (const [l, ids] of byLayer) {
    const totalW = ids.length * NODE_W + (ids.length - 1) * H_GAP;
    const startX = -totalW / 2;
    ids.forEach((id, idx) => {
      positions.set(id, {
        x: startX + idx * (NODE_W + H_GAP),
        y: l * (NODE_H + V_GAP),
      });
    });
  }

  return positions;
}
