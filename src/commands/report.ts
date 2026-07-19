import { renderReviewJson } from "../reporters/review-json.js";
import { renderReviewMarkdown } from "../reporters/review-markdown.js";
import { renderReviewTerminal } from "../reporters/review-terminal.js";
import { loadRun } from "../storage/runs.js";
import type { CommandOutputFormat } from "./output.js";

export async function runReportCommand(
  runId: string,
  format: CommandOutputFormat | "markdown" = "terminal",
): Promise<{ readonly exitCode: number; readonly output: string }> {
  try {
    const record = await loadRun(runId);
    const output =
      format === "json"
        ? renderReviewJson(record)
        : format === "markdown"
          ? renderReviewMarkdown(record)
          : renderReviewTerminal(record);
    return { exitCode: 0, output };
  } catch {
    return { exitCode: 2, output: `Run not found: ${runId}\n` };
  }
}
