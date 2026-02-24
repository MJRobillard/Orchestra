import type { PreviewSchemaNode, PreviewSchemaRoot } from "@/contracts/preview-schema";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nodeToHtml(node: PreviewSchemaNode): string {
  const children = Array.isArray(node.children) ? node.children.map((child) => nodeToHtml(child)).join("") : "";
  const text = typeof node.text === "string" ? escapeHtml(node.text) : "";
  const placeholder = typeof node.placeholder === "string" ? escapeHtml(node.placeholder) : "";

  if (node.type === "container") {
    return `<section data-node-id="${escapeHtml(node.id)}">${children}</section>`;
  }

  if (node.type === "heading") {
    return `<h2 data-node-id="${escapeHtml(node.id)}">${text || "Heading"}</h2>`;
  }

  if (node.type === "text") {
    return `<p data-node-id="${escapeHtml(node.id)}">${text || "Text"}</p>`;
  }

  if (node.type === "input") {
    return `<input data-node-id="${escapeHtml(node.id)}" placeholder="${placeholder || "Input"}" readonly />`;
  }

  const className = node.variant === "secondary" ? "btn btn-secondary" : "btn btn-primary";
  return `<button data-node-id="${escapeHtml(node.id)}" class="${className}" aria-disabled="true">${text || "Button"}</button>`;
}

export function schemaToSafeHtml(schema: PreviewSchemaRoot): string {
  const accent = schema.tokens?.accentColor ?? "#3b82f6";
  const radius = schema.tokens?.radius === "sm" ? "6px" : schema.tokens?.radius === "lg" ? "14px" : "10px";
  const spacing = schema.tokens?.spacing === "sm" ? "8px" : schema.tokens?.spacing === "lg" ? "16px" : "12px";

  const body = schema.tree.map((node) => nodeToHtml(node)).join("");

  return `<style>
main.concept {
  position: relative;
  border-radius: 20px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  padding: 18px;
  display: grid;
  gap: ${spacing};
  background:
    radial-gradient(circle at 12% 0%, rgba(59, 130, 246, 0.18), transparent 45%),
    radial-gradient(circle at 92% 100%, rgba(16, 185, 129, 0.16), transparent 42%),
    linear-gradient(145deg, #0b1222, #111c36 52%, #101a30);
  box-shadow: 0 24px 60px rgba(2, 6, 23, 0.45);
}
main.concept::before {
  content: "Concept Preview";
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #93c5fd;
  font-weight: 700;
}
section {
  border: 1px solid rgba(100, 116, 139, 0.6);
  border-radius: calc(${radius} + 2px);
  padding: calc(${spacing} + 2px);
  display: grid;
  gap: ${spacing};
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.78), rgba(15, 23, 42, 0.56));
  backdrop-filter: blur(6px);
}
h2 {
  margin: 0;
  font-size: 22px;
  line-height: 1.15;
  font-weight: 700;
  color: #f8fafc;
}
p {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: #dbeafe;
}
input {
  width: 100%;
  border: 1px solid rgba(148, 163, 184, 0.5);
  border-radius: ${radius};
  background: rgba(2, 6, 23, 0.55);
  color: #f1f5f9;
  padding: 10px 12px;
}
.btn {
  border-radius: ${radius};
  padding: 10px 14px;
  border: 1px solid transparent;
  color: white;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.btn-primary {
  background: linear-gradient(145deg, ${accent}, #1d4ed8);
  box-shadow: 0 8px 20px rgba(30, 64, 175, 0.38);
}
.btn-secondary {
  background: rgba(15, 23, 42, 0.35);
  border-color: rgba(148, 163, 184, 0.6);
  color: #f1f5f9;
}
</style><main class="concept">${body}</main>`;
}
