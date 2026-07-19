import type { AgentInstructionValidationReport } from "../instructions/reuse-validator.js";

export function renderValidationJson(
  report: AgentInstructionValidationReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
