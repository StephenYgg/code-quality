import type { ReviewRunResult } from "../review/orchestrator.js";
import type { StoredRunRecord } from "../storage/runs.js";

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
      lines.push(`### ${finding.severity}: ${finding.title}`, "");
      lines.push(`- ID: \`${finding.id}\``);
      lines.push(`- Evidence: ${finding.evidence}`);
      lines.push(`- Impact: ${finding.impact}`);
      lines.push(`- Remediation: ${finding.remediation}`, "");
    }
  }
  lines.push("## Uncertain", "");
  if (!("uncertain" in result) || result.uncertain.length === 0) {
    lines.push("_None._", "");
  } else {
    for (const finding of result.uncertain) {
      lines.push(`- ${finding.title} (\`${finding.id}\`)`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
