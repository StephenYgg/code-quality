import {
  AGENT_DOCUMENT_RULE_ID,
  type DiagnosticCategory,
  type ValidationDiagnostic,
} from "./validation.js";

export interface DiagnosticLocation {
  readonly line: number;
  readonly column: number;
}

export function agentDiagnostic(
  code: string,
  category: DiagnosticCategory,
  path: string,
  message: string,
  relatedPath?: string,
  location?: DiagnosticLocation,
): ValidationDiagnostic {
  const base = {
    ruleId: AGENT_DOCUMENT_RULE_ID,
    code,
    category,
    certainty: "deterministic" as const,
    path,
    message,
  };
  const withRelated =
    relatedPath === undefined ? base : { ...base, relatedPath };
  return location === undefined ? withRelated : { ...withRelated, ...location };
}
