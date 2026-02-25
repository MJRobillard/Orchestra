"use client";

import { useMemo, useState } from "react";
import type { PreviewCodeArtifact } from "@/contracts/preview-schema";

interface StrictSandboxCodePreviewProps {
  artifact: PreviewCodeArtifact;
}

const BOOTSTRAP_CSS_HREF = "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css";

function extractBodyMarkup(raw: string): string {
  const trimmed = raw.trim();
  const headStyles = Array.from(trimmed.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi))
    .map((match) => match[0])
    .join("\n");
  const bodyMatch = trimmed.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) {
    return [headStyles, bodyMatch[1].trim()].filter(Boolean).join("\n").trim();
  }

  return trimmed
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<\/?html[^>]*>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<\/?body[^>]*>/gi, "")
    .trim()
    .replace(/^/, headStyles ? `${headStyles}\n` : "");
}

function sanitizeForClient(raw: string): string {
  let sanitized = extractBodyMarkup(raw);
  sanitized = sanitized.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
  sanitized = sanitized.replace(/<(iframe|object|embed)\b[\s\S]*?>[\s\S]*?<\/\1>/gi, "");
  sanitized = sanitized.replace(/<(iframe|object|embed)\b[^>]*\/?>/gi, "");
  sanitized = sanitized.replace(/<head[\s\S]*?<\/head>/gi, "");
  sanitized = sanitized.replace(/<\/?(html|body|title|meta|base|link)\b[^>]*>/gi, "");
  sanitized = sanitized.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
  sanitized = sanitized.replace(/<link\b[^>]*>/gi, "");
  sanitized = sanitized.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  sanitized = sanitized.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  sanitized = sanitized.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  sanitized = sanitized.replace(/\s(href|src)\s*=\s*"javascript:[^"]*"/gi, "");
  sanitized = sanitized.replace(/\s(href|src)\s*=\s*'javascript:[^']*'/gi, "");
  sanitized = sanitized.replace(/\s(href|src)\s*=\s*"(https?:)?\/\/[^"]*"/gi, " $1=\"#\"");
  sanitized = sanitized.replace(/\s(href|src)\s*=\s*'(https?:)?\/\/[^']*'/gi, " $1='#'");
  sanitized = sanitized.replace(/\ssrcset\s*=\s*"[^"]*"/gi, "");
  sanitized = sanitized.replace(/\ssrcset\s*=\s*'[^']*'/gi, "");
  sanitized = sanitized.replace(/url\s*\(\s*(['"]?)(?:javascript:|https?:|\/\/)[^)]*\1\s*\)/gi, "none");
  return sanitized.trim();
}

function buildSrcDoc(rawHtml: string): string {
  const bodyMarkup = sanitizeForClient(rawHtml);

  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bubbly X Sprite - Fizzy Deals That Pop!</title>
    <link rel="stylesheet" href="${BOOTSTRAP_CSS_HREF}">
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        padding: 16px;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        background: #0f172a;
        color: #e2e8f0;
      }
      *, *::before, *::after { box-sizing: border-box; }
    </style>
  </head>
  <body>${bodyMarkup}</body>
</html>`;
}

export function StrictSandboxCodePreview({ artifact }: StrictSandboxCodePreviewProps) {
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const srcDoc = useMemo(() => buildSrcDoc(artifact.code), [artifact.code]);
  const frameWidth = viewport === "mobile" ? "390px" : "100%";

  return (
    <div
      className="rounded-xl border border-slate-700 bg-gradient-to-b from-slate-900 to-slate-950 p-3"
      data-testid="strict-sandbox-preview"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Human Review Canvas</p>
          <p className="text-xs font-medium text-slate-200">Visual concept inside safe sandbox</p>
        </div>
        <div className="flex items-center gap-1">
          <span className="rounded bg-emerald-700 px-2 py-1 text-[10px] text-emerald-100">
            Rendered HTML
          </span>
          <button
            type="button"
            className={`rounded px-2 py-1 text-[10px] ${viewport === "desktop" ? "bg-slate-600 text-white" : "bg-slate-800 text-slate-300"}`}
            onClick={() => setViewport("desktop")}
          >
            Desktop
          </button>
          <button
            type="button"
            className={`rounded px-2 py-1 text-[10px] ${viewport === "mobile" ? "bg-slate-600 text-white" : "bg-slate-800 text-slate-300"}`}
            onClick={() => setViewport("mobile")}
          >
            Mobile
          </button>
        </div>
      </div>

      <div className="flex justify-center rounded-lg border border-slate-700/80 bg-slate-900 p-2">
        <iframe
          title="Strict code preview"
          className="h-72 rounded border border-slate-700 bg-white transition-all"
          style={{ width: frameWidth }}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
        />
      </div>

      {artifact.sanitized ? (
        <p className="mt-2 text-[10px] text-amber-300">Unsafe elements were stripped before rendering.</p>
      ) : null}
    </div>
  );
}
