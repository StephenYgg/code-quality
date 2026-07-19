import type { AgentInstructionValidationReport } from "../instructions/reuse-validator.js";
import { escapeTerminalField } from "./terminal-safe.js";

export function renderValidationTerminal(
  report: AgentInstructionValidationReport,
): string {
  const lines = [
    `Gate: ${report.gate}`,
    `Rule: ${report.ruleId}`,
    `Repository: ${escapeTerminalField(report.repository)}`,
    `Scopes checked: ${String(report.scopesChecked)}`,
    `Files checked: ${String(report.filesChecked)}`,
    `Diagnostics: ${String(report.diagnostics.length)}`,
  ];

  for (const diagnostic of report.diagnostics) {
    const label = diagnostic.category === "incomplete" ? "INCOMPLETE" : "WARN";
    const related =
      diagnostic.relatedPath === undefined
        ? ""
        : ` (related: ${escapeTerminalField(diagnostic.relatedPath)})`;
    const location =
      diagnostic.line === undefined
        ? ""
        : `:${String(diagnostic.line)}:${String(diagnostic.column ?? 1)}`;
    lines.push(
      `[${label}] ${diagnostic.code} ${escapeTerminalField(diagnostic.path)}${location}${related}: ${escapeTerminalField(diagnostic.message)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
