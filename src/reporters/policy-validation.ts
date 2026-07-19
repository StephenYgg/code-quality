import type { PolicyDiagnostic } from "../core/policy.js";
import type { AgentInstructionValidationReport } from "../instructions/reuse-validator.js";
import { escapeTerminalField } from "./terminal-safe.js";

export type AggregateValidationGate = "PASS" | "WARN" | "BLOCK" | "INCOMPLETE";

export interface PolicyValidationSummary {
  readonly profile?: { readonly id: string; readonly version: number };
  readonly policyHash?: string;
  readonly ruleCount: number;
  readonly waiverCount: number;
  readonly sourceCount: number;
  readonly diagnostics: readonly PolicyDiagnostic[];
}

export interface AggregateValidationReport {
  readonly gate: AggregateValidationGate;
  readonly ruleId: "CQ-AGENT-001";
  readonly repository: string;
  readonly agentInstructions: AgentInstructionValidationReport;
  readonly policy: PolicyValidationSummary;
}

export function renderAggregateValidationJson(
  report: AggregateValidationReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderAggregateValidationTerminal(
  report: AggregateValidationReport,
): string {
  const lines = [
    `Gate: ${report.gate}`,
    `Repository: ${escapeTerminalField(report.repository)}`,
    `Agent instruction gate: ${report.agentInstructions.gate}`,
    `Agent diagnostics: ${String(report.agentInstructions.diagnostics.length)}`,
    `Policy rules: ${String(report.policy.ruleCount)}`,
    `Policy waivers: ${String(report.policy.waiverCount)}`,
    `Policy diagnostics: ${String(report.policy.diagnostics.length)}`,
  ];
  if (report.policy.profile !== undefined) {
    lines.push(
      `Profile: ${escapeTerminalField(report.policy.profile.id)} v${String(report.policy.profile.version)}`,
    );
  }
  for (const diagnostic of report.agentInstructions.diagnostics) {
    lines.push(
      `[AGENT] ${diagnostic.code} ${escapeTerminalField(diagnostic.path)}: ${escapeTerminalField(diagnostic.message)}`,
    );
  }
  for (const diagnostic of report.policy.diagnostics) {
    lines.push(
      `[POLICY] ${diagnostic.code} ${escapeTerminalField(diagnostic.source)}${escapeTerminalField(diagnostic.path)}: ${escapeTerminalField(diagnostic.message)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
