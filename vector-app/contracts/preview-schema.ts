export type PreviewComponentType = "container" | "heading" | "text" | "button" | "input";

export interface PreviewDesignTokens {
  accentColor?: string;
  radius?: "sm" | "md" | "lg";
  spacing?: "sm" | "md" | "lg";
}

export interface PreviewSchemaNode {
  id: string;
  type: PreviewComponentType;
  text?: string;
  placeholder?: string;
  variant?: "primary" | "secondary";
  children?: PreviewSchemaNode[];
}

export interface PreviewSchemaRoot {
  version: 1;
  tokens?: PreviewDesignTokens;
  tree: PreviewSchemaNode[];
}

export type PreviewRenderMode = "schema" | "code";

export interface PreviewCodeArtifact {
  language: "html";
  code: string;
  sanitized?: boolean;
}

export interface StructuredPhaseOutputPayload {
  renderMode?: PreviewRenderMode;
  uiSchema: PreviewSchemaRoot;
  uiCode?: PreviewCodeArtifact;
  diff: string;
  rubricResults: Array<{
    criterion: string;
    score: number;
    maxScore: number;
    note?: string;
  }>;
}
