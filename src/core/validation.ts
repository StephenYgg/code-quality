export const AGENT_DOCUMENT_RULE_ID = "CQ-AGENT-001" as const;

export type ValidationGate = "PASS" | "WARN" | "BLOCK" | "INCOMPLETE";
export type DiagnosticCertainty = "deterministic" | "review_required";
export type DiagnosticCategory = "policy" | "incomplete";

export interface ValidationDiagnostic {
  readonly ruleId: typeof AGENT_DOCUMENT_RULE_ID;
  readonly code: string;
  readonly category: DiagnosticCategory;
  readonly certainty: DiagnosticCertainty;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly relatedPath?: string;
  readonly message: string;
}
