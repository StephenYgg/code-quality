import type { PolicyDiagnostic, RuleDefinition } from "../core/policy.js";
import { escapeTerminalField } from "./terminal-safe.js";

export interface RuleListReport {
  readonly gate: "PASS" | "BLOCK" | "INCOMPLETE";
  readonly policyHash?: string;
  readonly rules: readonly RuleDefinition[];
  readonly diagnostics: readonly PolicyDiagnostic[];
}

export interface RuleExplanationReport {
  readonly gate: "PASS" | "BLOCK" | "INCOMPLETE";
  readonly policyHash?: string;
  readonly rule?: RuleDefinition;
  readonly diagnostics: readonly PolicyDiagnostic[];
}

export function renderRulesJson(
  report: RuleListReport | RuleExplanationReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderRuleListTerminal(report: RuleListReport): string {
  const lines = [
    `Gate: ${report.gate}`,
    `Rules: ${String(report.rules.length)}`,
  ];
  for (const rule of report.rules) {
    lines.push(
      `${rule.id} v${String(rule.version)} [${rule.scope}/${rule.detection}] ${escapeTerminalField(rule.title)}`,
    );
  }
  for (const diagnostic of report.diagnostics) {
    lines.push(
      `[POLICY] ${diagnostic.code}: ${escapeTerminalField(diagnostic.message)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderRuleExplanationTerminal(
  report: RuleExplanationReport,
): string {
  if (report.rule === undefined) {
    const diagnostic = report.diagnostics[0];
    return `Gate: ${report.gate}\n${diagnostic === undefined ? "Rule was not found" : `${diagnostic.code}: ${escapeTerminalField(diagnostic.message)}`}\n`;
  }
  const rule = report.rule;
  return `${[
    `Gate: ${report.gate}`,
    `Rule: ${rule.id}`,
    `Version: ${String(rule.version)}`,
    `Title: ${escapeTerminalField(rule.title)}`,
    `Scope: ${rule.scope}`,
    `Severity: ${rule.defaultSeverity}`,
    `Gate mode: ${rule.gateMode}`,
    `Detection: ${rule.detection}`,
    `Rationale: ${escapeTerminalField(rule.rationale)}`,
    `Required evidence: ${rule.requiredEvidence.map((item) => escapeTerminalField(item)).join("; ")}`,
    `Remediation: ${escapeTerminalField(rule.remediation)}`,
    `Verification: ${escapeTerminalField(rule.verification)}`,
  ].join("\n")}\n`;
}
