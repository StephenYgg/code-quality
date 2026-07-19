import type { ScoreResult } from "../core/scoring.js";
import { escapeTerminalField } from "./terminal-safe.js";

export interface ScoreCommandDiagnostic {
  readonly code: "FILE_CHANGED" | "FILE_LIMIT_EXCEEDED" | "INVALID_SCORE_INPUT";
  readonly message: string;
}

export interface ScoreFailureReport {
  readonly gate: "BLOCK" | "INCOMPLETE";
  readonly diagnostics: readonly ScoreCommandDiagnostic[];
}

export function renderScoreJson(
  report: ScoreResult | ScoreFailureReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderScoreTerminal(
  report: ScoreResult | ScoreFailureReport,
): string {
  if ("diagnostics" in report) {
    return `${[
      `Gate: ${report.gate}`,
      ...report.diagnostics.map(
        (diagnostic) =>
          `${diagnostic.code}: ${escapeTerminalField(diagnostic.message)}`,
      ),
    ].join("\n")}\n`;
  }
  const lines = [
    `Gate: ${report.gate}`,
    `Scope: ${report.scope}`,
    `Score: ${report.display.normalized}/${report.display.applicableMaximum}`,
    `Coverage: ${report.display.coverage}%`,
    `Confidence: ${report.confidence ?? "N/A"}`,
    `Model: ${escapeTerminalField(report.model.id)}@${escapeTerminalField(report.model.version)}`,
  ];
  for (const major of report.majors) {
    lines.push(
      `${escapeTerminalField(major.name)}: ${major.display.normalized}/${major.display.applicableMaximum} (${major.display.coverage}% coverage)`,
    );
    for (const minor of major.minors) {
      lines.push(
        `  ${escapeTerminalField(minor.name)}: ${minor.display.earned}/${minor.display.maximum} [${minor.assessment.status}]`,
      );
    }
  }
  if (report.baseline !== undefined) {
    lines.push(`Delta: ${report.baseline.display.normalizedDelta}`);
    for (const change of report.baseline.majorChanges) {
      lines.push(
        `Major delta ${escapeTerminalField(change.majorId)}: ${change.display.normalizedDelta} [${change.comparable ? "comparable" : "not comparable"}]`,
      );
    }
    for (const change of report.baseline.minorChanges) {
      lines.push(
        `Minor delta ${escapeTerminalField(change.minorId)}: ${change.display.earnedDelta} [${change.comparisonReason}]`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
