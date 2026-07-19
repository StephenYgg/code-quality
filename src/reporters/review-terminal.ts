import type { ReviewRunResult } from "../review/orchestrator.js";
import type { StoredRunRecord } from "../storage/runs.js";
import { escapeTerminalField } from "./terminal-safe.js";

export function renderReviewTerminal(
  result: ReviewRunResult | StoredRunRecord,
): string {
  const lines = [
    `Gate: ${result.gate}`,
    `Run: ${result.runId}`,
    `Report: ${result.reportHash}`,
    `Incomplete: ${result.incomplete ? "yes" : "no"}`,
    "",
    "Findings:",
  ];
  if (result.findings.length === 0) {
    lines.push("- none");
  } else {
    for (const finding of result.findings) {
      lines.push(
        `- [${finding.severity}] ${escapeTerminalField(finding.title)} (${finding.id})`,
      );
      lines.push(`  evidence: ${escapeTerminalField(finding.evidence)}`);
    }
  }
  lines.push("", "Uncertain:");
  if (!("uncertain" in result) || result.uncertain.length === 0) {
    lines.push("- none");
  } else {
    for (const finding of result.uncertain) {
      lines.push(`- ${escapeTerminalField(finding.title)} (${finding.id})`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
