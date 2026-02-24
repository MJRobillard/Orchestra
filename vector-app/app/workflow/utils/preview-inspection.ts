import type { PreviewSchemaNode, PreviewSchemaRoot } from "@/contracts/preview-schema";

export type InspectionScale = "all" | "macro" | "micro";

export interface PreviewInspectionNode {
  id: string;
  type: PreviewSchemaNode["type"];
  text?: string;
  placeholder?: string;
  depth: number;
  childCount: number;
  subtreeSize: number;
  path: string;
  scale: Exclude<InspectionScale, "all">;
}

function getNodeLabel(node: PreviewSchemaNode): string {
  return node.text ?? node.placeholder ?? node.type;
}

function classifyScale(node: PreviewSchemaNode, depth: number, subtreeSize: number): "macro" | "micro" {
  if (node.type === "container") return "macro";
  if (depth <= 1 && subtreeSize > 1) return "macro";
  return "micro";
}

function walkNode(
  node: PreviewSchemaNode,
  depth: number,
  pathPrefix: string,
): { nodes: PreviewInspectionNode[]; subtreeSize: number } {
  const children = Array.isArray(node.children) ? node.children : [];
  const currentPath = pathPrefix ? `${pathPrefix} > ${getNodeLabel(node)}` : getNodeLabel(node);

  const childResults = children.map((child) => walkNode(child, depth + 1, currentPath));
  const subtreeSize = 1 + childResults.reduce((sum, item) => sum + item.subtreeSize, 0);

  const current: PreviewInspectionNode = {
    id: node.id,
    type: node.type,
    text: node.text,
    placeholder: node.placeholder,
    depth,
    childCount: children.length,
    subtreeSize,
    path: currentPath,
    scale: classifyScale(node, depth, subtreeSize),
  };

  return {
    nodes: [current, ...childResults.flatMap((item) => item.nodes)],
    subtreeSize,
  };
}

export function buildPreviewInspectionTree(schema?: PreviewSchemaRoot): PreviewInspectionNode[] {
  if (!schema?.tree?.length) return [];
  return schema.tree.flatMap((node) => walkNode(node, 0, "").nodes);
}

export function filterInspectionNodes(
  nodes: PreviewInspectionNode[],
  scale: InspectionScale,
): PreviewInspectionNode[] {
  if (scale === "all") return nodes;
  return nodes.filter((node) => node.scale === scale);
}
