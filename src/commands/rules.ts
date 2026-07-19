import { resolveEffectivePolicy, type RuleDefinition } from "../core/policy.js";
import {
  renderRuleExplanationTerminal,
  renderRuleListTerminal,
  renderRulesJson,
  type RuleExplanationReport,
  type RuleListReport,
} from "../reporters/rules.js";
import type { CommandOutputFormat, RenderedCommandResult } from "./output.js";
import { classifyPolicyDiagnostics } from "./policy-status.js";

export interface RuleCommandOptions {
  readonly format: CommandOutputFormat;
  readonly profileName?: string;
  readonly repository?: string;
}

function compareRule(left: RuleDefinition, right: RuleDefinition): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function repositoryFor(options: RuleCommandOptions): string {
  return options.repository ?? process.cwd();
}

function unavailablePolicyGate(
  diagnostics: Parameters<typeof classifyPolicyDiagnostics>[0],
): "BLOCK" | "INCOMPLETE" {
  return classifyPolicyDiagnostics(diagnostics).gate === "INCOMPLETE"
    ? "INCOMPLETE"
    : "BLOCK";
}

function exitCodeFor(gate: RuleListReport["gate"]): number {
  return gate === "PASS" ? 0 : gate === "INCOMPLETE" ? 3 : 2;
}

export async function runRuleListCommand(
  options: RuleCommandOptions,
): Promise<RenderedCommandResult<RuleListReport>> {
  const policy = await resolveEffectivePolicy({
    repository: repositoryFor(options),
    ...(options.profileName === undefined
      ? {}
      : { profileName: options.profileName }),
  });
  const report: RuleListReport = {
    gate:
      policy.policy === undefined
        ? unavailablePolicyGate(policy.diagnostics)
        : "PASS",
    ...(policy.policyHash === undefined
      ? {}
      : { policyHash: policy.policyHash }),
    rules: [...(policy.policy?.rules ?? [])].sort(compareRule),
    diagnostics: policy.diagnostics,
  };
  return {
    exitCode: exitCodeFor(report.gate),
    output:
      options.format === "json"
        ? renderRulesJson(report)
        : renderRuleListTerminal(report),
    report,
  };
}

export async function runRuleExplainCommand(
  ruleId: string,
  options: RuleCommandOptions,
): Promise<RenderedCommandResult<RuleExplanationReport>> {
  const policy = await resolveEffectivePolicy({
    repository: repositoryFor(options),
    ...(options.profileName === undefined
      ? {}
      : { profileName: options.profileName }),
  });
  const validRuleId = /^CQ-[A-Z0-9-]{1,64}$/u.test(ruleId);
  const rule = validRuleId
    ? policy.policy?.rules.find((candidate) => candidate.id === ruleId)
    : undefined;
  const diagnostics =
    policy.diagnostics.length > 0
      ? policy.diagnostics
      : rule === undefined
        ? [
            {
              code: "RULE_NOT_FOUND",
              source: "invocation",
              path: "/ruleId",
              message: "Requested rule was not found in the effective policy",
            },
          ]
        : [];
  const report: RuleExplanationReport = {
    gate:
      policy.policy === undefined
        ? unavailablePolicyGate(policy.diagnostics)
        : rule === undefined
          ? "BLOCK"
          : "PASS",
    ...(policy.policyHash === undefined
      ? {}
      : { policyHash: policy.policyHash }),
    ...(rule === undefined ? {} : { rule }),
    diagnostics,
  };
  return {
    exitCode: exitCodeFor(report.gate),
    output:
      options.format === "json"
        ? renderRulesJson(report)
        : renderRuleExplanationTerminal(report),
    report,
  };
}
