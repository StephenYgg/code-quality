import { resolveEffectivePolicy } from "../core/policy.js";
import {
  validateAgentInstructions,
  type AgentInstructionValidationReport,
} from "../instructions/reuse-validator.js";
import {
  renderAggregateValidationJson,
  renderAggregateValidationTerminal,
  type AggregateValidationGate,
  type AggregateValidationReport,
} from "../reporters/policy-validation.js";
import type { CommandOutputFormat, RenderedCommandResult } from "./output.js";
import {
  classifyPolicyDiagnostics,
  type PolicyDiagnosticClassification,
} from "./policy-status.js";

export { classifyPolicyDiagnostics } from "./policy-status.js";

export type ValidationOutputFormat = CommandOutputFormat;
export type ValidateCommandResult =
  RenderedCommandResult<AggregateValidationReport>;

function gatePriority(gate: AggregateValidationGate): number {
  switch (gate) {
    case "BLOCK":
      return 3;
    case "INCOMPLETE":
      return 2;
    case "WARN":
      return 1;
    case "PASS":
      return 0;
  }
}

function maximumGate(
  left: AggregateValidationGate,
  right: AggregateValidationGate,
): AggregateValidationGate {
  return gatePriority(left) >= gatePriority(right) ? left : right;
}

function exitCodeFor(
  agent: AgentInstructionValidationReport,
  policy: PolicyDiagnosticClassification,
  gate: AggregateValidationGate,
): number {
  if (policy.invalid) return 2;
  if (gate === "BLOCK") return 1;
  if (gate === "INCOMPLETE" || agent.gate === "INCOMPLETE") return 3;
  return 0;
}

export async function runValidateCommand(
  repository: string,
  format: ValidationOutputFormat,
): Promise<ValidateCommandResult> {
  const agentInstructions = await validateAgentInstructions(repository);
  const policyResult = await resolveEffectivePolicy({ repository });
  const policyDiagnostics = classifyPolicyDiagnostics(policyResult.diagnostics);
  const gate = maximumGate(agentInstructions.gate, policyDiagnostics.gate);
  const report: AggregateValidationReport = {
    gate,
    ruleId: "CQ-AGENT-001",
    repository: agentInstructions.repository,
    agentInstructions,
    policy: {
      ...(policyResult.policy === undefined
        ? {}
        : { profile: policyResult.policy.profile }),
      ...(policyResult.policyHash === undefined
        ? {}
        : { policyHash: policyResult.policyHash }),
      ruleCount: policyResult.policy?.rules.length ?? 0,
      waiverCount: policyResult.waivers.length,
      sourceCount: policyResult.sources.length,
      diagnostics: policyResult.diagnostics,
    },
  };
  return {
    exitCode: exitCodeFor(agentInstructions, policyDiagnostics, gate),
    output:
      format === "json"
        ? renderAggregateValidationJson(report)
        : renderAggregateValidationTerminal(report),
    report,
  };
}
