"use client";

import type { ReactNode } from "react";
import type { PreviewDesignTokens, PreviewSchemaNode, PreviewSchemaRoot } from "@/contracts/preview-schema";

interface ControlledPreviewRuntimeProps {
  schema: PreviewSchemaRoot;
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
}

function resolveRadius(radius?: PreviewDesignTokens["radius"]): string {
  if (radius === "sm") return "6px";
  if (radius === "lg") return "14px";
  return "10px";
}

function resolveSpacing(spacing?: PreviewDesignTokens["spacing"]): string {
  if (spacing === "sm") return "8px";
  if (spacing === "lg") return "16px";
  return "12px";
}

function nodeChromeClasses(isSelected: boolean, clickable: boolean): string {
  const ring = isSelected ? "ring-2 ring-sky-400/80" : "ring-1 ring-transparent";
  const hover = clickable ? "cursor-pointer hover:ring-sky-400/50" : "";
  return `${ring} ${hover}`.trim();
}

function renderNode(
  node: PreviewSchemaNode,
  tokens: PreviewSchemaRoot["tokens"],
  selectedNodeId?: string,
  onSelectNode?: (nodeId: string) => void,
): ReactNode {
  const accent = tokens?.accentColor ?? "#8B5CF6";
  const radius = resolveRadius(tokens?.radius);
  const spacing = resolveSpacing(tokens?.spacing);
  const children = Array.isArray(node.children)
    ? node.children.map((child) => renderNode(child, tokens, selectedNodeId, onSelectNode))
    : null;

  const selected = selectedNodeId === node.id;
  const clickable = Boolean(onSelectNode);
  const onClick = () => {
    if (onSelectNode) onSelectNode(node.id);
  };

  if (node.type === "container") {
    return (
      <div
        key={node.id}
        className={`border border-slate-700 bg-slate-900/70 ${nodeChromeClasses(selected, clickable)}`}
        style={{ borderRadius: radius, padding: spacing, display: "grid", gap: spacing }}
        onClick={onClick}
        data-node-id={node.id}
        data-selected={selected ? "true" : "false"}
      >
        {children}
      </div>
    );
  }

  if (node.type === "heading") {
    return (
      <h4
        key={node.id}
        className={`text-sm font-semibold text-slate-100 ${nodeChromeClasses(selected, clickable)}`}
        onClick={onClick}
        data-node-id={node.id}
        data-selected={selected ? "true" : "false"}
      >
        {node.text ?? "Heading"}
      </h4>
    );
  }

  if (node.type === "text") {
    return (
      <p
        key={node.id}
        className={`text-xs text-slate-300 ${nodeChromeClasses(selected, clickable)}`}
        onClick={onClick}
        data-node-id={node.id}
        data-selected={selected ? "true" : "false"}
      >
        {node.text ?? "Text"}
      </p>
    );
  }

  if (node.type === "input") {
    return (
      <input
        key={node.id}
        readOnly
        className={`w-full border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200 ${nodeChromeClasses(selected, clickable)}`}
        style={{ borderRadius: radius }}
        placeholder={node.placeholder ?? "Input"}
        onClick={onClick}
        data-node-id={node.id}
        data-selected={selected ? "true" : "false"}
      />
    );
  }

  return (
    <button
      key={node.id}
      type="button"
      aria-disabled="true"
      className={`${
        node.variant === "secondary"
          ? "rounded border border-slate-600 bg-transparent px-2 py-1.5 text-xs text-slate-200"
          : "rounded px-2 py-1.5 text-xs font-medium text-white"
      } ${nodeChromeClasses(selected, clickable)}`}
      style={node.variant === "secondary" ? undefined : { backgroundColor: accent, borderRadius: radius }}
      onClick={(event) => {
        event.preventDefault();
        onClick();
      }}
      data-node-id={node.id}
      data-selected={selected ? "true" : "false"}
    >
      {node.text ?? "Button"}
    </button>
  );
}

export function ControlledPreviewRuntime({
  schema,
  selectedNodeId,
  onSelectNode,
}: ControlledPreviewRuntimeProps) {
  return (
    <div className="rounded border border-slate-700 bg-slate-950/60 p-3" data-testid="controlled-preview-runtime">
      <p className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">Controlled Runtime Preview</p>
      <div className="grid gap-2">
        {schema.tree.map((node) => renderNode(node, schema.tokens, selectedNodeId, onSelectNode))}
      </div>
    </div>
  );
}
