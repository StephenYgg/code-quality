import type { ReviewRunResult } from "../review/orchestrator.js";
import type { StoredRunRecord } from "../storage/runs.js";
import { redactSecrets } from "../providers/provider.js";
import { escapeTerminalField } from "./terminal-safe.js";

const MAX_REPORTED_DIAGNOSTICS = 8;

function isReviewRunResult(
  result: ReviewRunResult | StoredRunRecord,
): result is ReviewRunResult {
  return "snapshot" in result;
}

function appendFindingSummary(
  lines: string[],
  heading: string,
  findings: ReviewRunResult["findings"],
): void {
  lines.push("", `${heading}:`);
  if (findings.length === 0) {
    lines.push("- none");
    return;
  }
  for (const finding of findings) {
    lines.push(
      `- [${finding.severity}] ${escapeTerminalField(finding.title)} (${finding.id})`,
    );
  }
}

function appendFindings(
  lines: string[],
  findings: ReviewRunResult["findings"],
): void {
  if (findings.length === 0) {
    lines.push("- none");
    return;
  }
  for (const finding of findings) {
    lines.push(
      `- [${finding.severity}] ${escapeTerminalField(finding.title)} (${finding.id})`,
      `  evidence: ${escapeTerminalField(finding.evidence)}`,
    );
    if (finding.location?.path !== undefined) {
      lines.push(`  path: ${escapeTerminalField(finding.location.path)}`);
    }
    if (finding.verification !== undefined) {
      lines.push(
        `  verification: ${escapeTerminalField(finding.verification)}`,
      );
    }
  }
}

function appendDiagnostics(
  lines: string[],
  diagnostics: NonNullable<ReviewRunResult["diagnostics"]>,
): void {
  if (diagnostics.length === 0) return;
  lines.push("", "Diagnostics:");
  for (const diagnostic of diagnostics.slice(0, MAX_REPORTED_DIAGNOSTICS)) {
    const location =
      diagnostic.path === undefined
        ? ""
        : ` ${escapeTerminalField(diagnostic.path, 256)}`;
    lines.push(
      `- [${escapeTerminalField(diagnostic.code, 120)}] ${escapeTerminalField(diagnostic.stageId, 120)}${location}: ${escapeTerminalField(redactSecrets(diagnostic.message, []), 512)}`,
    );
  }
  const omitted = diagnostics.length - MAX_REPORTED_DIAGNOSTICS;
  if (omitted > 0)
    lines.push(`- ${String(omitted)} additional diagnostics omitted`);
}

function appendAssessments(
  lines: string[],
  assessments: ReviewRunResult["assessments"],
): void {
  lines.push("", "Assessments:");
  for (const assessment of assessments.slice(0, 32)) {
    if (assessment.status === "scored") {
      lines.push(
        `- ${assessment.minorId}: ${String(assessment.rating)} (${assessment.confidence})`,
      );
    } else if (assessment.status === "not_assessed") {
      lines.push(
        `- ${assessment.minorId}: not_assessed (${assessment.reason})`,
      );
    } else {
      lines.push(`- ${assessment.minorId}: n/a (${assessment.reason})`);
    }
  }
}

function appendScore(lines: string[], score: ReviewRunResult["score"]): void {
  if (score === undefined) return;
  lines.push(
    "",
    "Score:",
    `- model: ${escapeTerminalField(score.model.id)}@${escapeTerminalField(score.model.version)}`,
    `- total: ${score.display.normalized}/${score.display.applicableMaximum}`,
    `- coverage: ${score.display.coverage}%`,
    `- confidence: ${score.confidence ?? "N/A"}`,
    `- scope: ${score.scope}`,
  );
}

export function renderReviewTerminal(
  result: ReviewRunResult | StoredRunRecord,
): string {
  const scoreGate = isReviewRunResult(result)
    ? result.scoreGate
    : result.scoreGate;
  const assessments = isReviewRunResult(result)
    ? result.assessments
    : result.assessments;
  const score = isReviewRunResult(result) ? result.score : undefined;
  const hasScoreOutput = score !== undefined || assessments.length > 0;
  const lines = [
    `Gate: ${result.gate}`,
    ...(hasScoreOutput ? [`ScoreGate: ${scoreGate}`] : []),
    `Run: ${result.runId}`,
    `Report: ${result.reportHash}`,
    `Incomplete: ${result.incomplete ? "yes" : "no"}`,
    "",
    "Findings:",
  ];
  appendFindings(lines, result.findings);
  appendFindingSummary(lines, "Corroborated", result.corroborated);
  appendFindingSummary(lines, "Uncertain", result.uncertain);
  appendFindingSummary(lines, "Waived", result.waived);
  appendDiagnostics(lines, result.diagnostics ?? []);
  if (hasScoreOutput) appendAssessments(lines, assessments);
  appendScore(lines, score);
  lines.push(
    "",
    "Residual risk:",
    result.incomplete
      ? "- Review incomplete; do not treat Gate PASS as full assurance."
      : "- No structural incompleteness recorded by orchestrator.",
    "",
  );
  return `${lines.join("\n")}\n`;
}
