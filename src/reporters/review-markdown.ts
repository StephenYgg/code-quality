import type { ReviewRunResult } from "../review/orchestrator.js";
import type { StoredRunRecord } from "../storage/runs.js";
import { redactSecrets } from "../providers/provider.js";
import { escapeTerminalField } from "./terminal-safe.js";

const MAX_REPORTED_DIAGNOSTICS = 8;

function markdownInline(value: string, maximumBytes = 2_048): string {
  return escapeTerminalField(redactSecrets(value, []), maximumBytes)
    .replace(/([\\`*_[\]{}()#+.!|-])/gu, "\\$1")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/\b(https?):\/\//giu, "$1&#58;//")
    .replace(/@/gu, "&#64;");
}

function markdownDiagnosticMessage(value: string): string {
  return markdownInline(value, 512).replace(/\\\[REDACTED\\\]/gu, "[REDACTED]");
}

function appendFindingList(
  lines: string[],
  heading: string,
  findings: ReviewRunResult["findings"],
): void {
  lines.push(`## ${heading}`, "");
  if (findings.length === 0) {
    lines.push("_None._", "");
    return;
  }
  for (const finding of findings) {
    lines.push(
      `- **${finding.severity}** ${markdownInline(finding.title, 300)} (${markdownInline(finding.id, 300)})`,
    );
  }
  lines.push("");
}

export function renderReviewMarkdown(
  result: ReviewRunResult | StoredRunRecord,
): string {
  const lines = [
    `# Code Quality Review`,
    "",
    `- Gate: **${result.gate}**`,
    `- Run: \`${result.runId}\``,
    `- Report hash: \`${result.reportHash}\``,
    `- Incomplete: ${result.incomplete ? "yes" : "no"}`,
    "",
    "## Findings",
    "",
  ];
  if (result.findings.length === 0) {
    lines.push("_No confirmed findings._", "");
  } else {
    for (const finding of result.findings) {
      lines.push(
        `### ${finding.severity}: ${markdownInline(finding.title, 300)}`,
        "",
      );
      lines.push(`- ID: ${markdownInline(finding.id, 300)}`);
      lines.push(`- Evidence: ${markdownInline(finding.evidence)}`);
      lines.push(`- Impact: ${markdownInline(finding.impact)}`);
      lines.push(`- Remediation: ${markdownInline(finding.remediation)}`, "");
    }
  }
  appendFindingList(lines, "Corroborated", result.corroborated);
  appendFindingList(lines, "Uncertain", result.uncertain);
  appendFindingList(lines, "Waived", result.waived);
  const diagnostics = result.diagnostics ?? [];
  if (diagnostics.length > 0) {
    lines.push("## Diagnostics", "");
    for (const diagnostic of diagnostics.slice(0, MAX_REPORTED_DIAGNOSTICS)) {
      const location =
        diagnostic.path === undefined
          ? ""
          : ` ${markdownInline(diagnostic.path, 256)}`;
      lines.push(
        `- **${escapeTerminalField(diagnostic.code, 120)}** ${escapeTerminalField(diagnostic.stageId, 120)}${location}: ${markdownDiagnosticMessage(diagnostic.message)}`,
      );
    }
    if (diagnostics.length > MAX_REPORTED_DIAGNOSTICS) {
      lines.push(
        `- ${String(diagnostics.length - MAX_REPORTED_DIAGNOSTICS)} additional diagnostics omitted`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
