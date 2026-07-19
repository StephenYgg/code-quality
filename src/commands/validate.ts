import {
  validateAgentInstructions,
  type AgentInstructionValidationReport,
} from "../instructions/reuse-validator.js";
import { renderValidationJson } from "../reporters/validation-json.js";
import { renderValidationTerminal } from "../reporters/validation-terminal.js";

export type ValidationOutputFormat = "json" | "terminal";

export interface ValidateCommandResult {
  readonly exitCode: number;
  readonly output: string;
  readonly report: AgentInstructionValidationReport;
}

function exitCodeFor(report: AgentInstructionValidationReport): number {
  if (report.gate === "BLOCK") {
    return 1;
  }
  if (report.gate === "INCOMPLETE") {
    return 3;
  }
  return 0;
}

export async function runValidateCommand(
  repository: string,
  format: ValidationOutputFormat,
): Promise<ValidateCommandResult> {
  const report = await validateAgentInstructions(repository);
  return {
    exitCode: exitCodeFor(report),
    output:
      format === "json"
        ? renderValidationJson(report)
        : renderValidationTerminal(report),
    report,
  };
}
