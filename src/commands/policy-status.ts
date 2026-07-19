import type { PolicyDiagnostic } from "../core/policy.js";

const INCOMPLETE_POLICY_CODES = new Set([
  "CONFIG_CHANGED_DURING_READ",
  "CONFIG_READ_FAILED",
  "CONFIG_RESOLUTION_TOO_LARGE",
  "DIAGNOSTIC_LIMIT_EXCEEDED",
  "WAIVER_DIRECTORY_ENTRY_LIMIT_EXCEEDED",
  "WAIVER_DIRECTORY_UNSUPPORTED",
  "WAIVER_FILE_LIMIT_EXCEEDED",
  "WAIVER_LIMIT_EXCEEDED",
  "WAIVER_LOCATION_CHANGED",
  "WAIVER_LOCATION_UNSUPPORTED",
]);

export interface PolicyDiagnosticClassification {
  readonly gate: "PASS" | "BLOCK" | "INCOMPLETE";
  readonly invalid: boolean;
}

function isIncompletePolicyDiagnostic(diagnostic: PolicyDiagnostic): boolean {
  return (
    INCOMPLETE_POLICY_CODES.has(diagnostic.code) ||
    diagnostic.code.endsWith("_LIMIT_EXCEEDED")
  );
}

export function classifyPolicyDiagnostics(
  diagnostics: readonly PolicyDiagnostic[],
): PolicyDiagnosticClassification {
  const invalid = diagnostics.some(
    (diagnostic) => !isIncompletePolicyDiagnostic(diagnostic),
  );
  return {
    gate: invalid ? "BLOCK" : diagnostics.length > 0 ? "INCOMPLETE" : "PASS",
    invalid,
  };
}
