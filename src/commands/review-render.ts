import { writeFile } from "node:fs/promises";

import type { ResolvedReviewProvider } from "../providers/resolve.js";
import { renderReviewJson } from "../reporters/review-json.js";
import { renderReviewMarkdown } from "../reporters/review-markdown.js";
import { renderReviewTerminal } from "../reporters/review-terminal.js";
import { renderScoreTerminal } from "../reporters/score.js";
import type { ReviewRunResult } from "../review/orchestrator.js";
import { retainReviewTranscript } from "../storage/transcripts.js";
import type { ReviewCommandOptions, ReviewCommandResult } from "./review.js";

function gateExitCode(
  gate: string,
  incomplete: boolean,
  scoreGate?: string,
): number {
  if (incomplete || gate === "INCOMPLETE" || scoreGate === "INCOMPLETE") {
    return 3;
  }
  if (gate === "BLOCK") return 1;
  return 0;
}

function terminalHeader(
  result: ReviewRunResult,
  options: ReviewCommandOptions,
  provider: ResolvedReviewProvider | undefined,
): string {
  return [
    provider !== undefined && provider.providerName !== "injected"
      ? `Provider: ${provider.providerName} (${provider.kind}) model=${provider.model}`
      : undefined,
    options.score === true ? `ScoreGate: ${result.scoreGate}` : undefined,
    `ContextIncomplete: ${result.contextIncomplete ? "yes" : "no"}`,
    options.reviewPreset === undefined
      ? undefined
      : `ReviewPreset: ${options.reviewPreset}`,
    options.hookPreset === undefined
      ? undefined
      : `HookPreset: ${options.hookPreset}`,
    result.fromCache === true ? "Cache: hit" : undefined,
    result.cacheKey === undefined
      ? undefined
      : `CacheKey: ${result.cacheKey.slice(0, 16)}…`,
    options.score === true
      ? `Assessments: ${String(result.assessments.length)}`
      : undefined,
    result.score === undefined
      ? undefined
      : `Score: ${result.score.display.normalized}/${result.score.display.applicableMaximum} coverage=${result.score.display.coverage}% model=${result.score.model.id}@${result.score.model.version}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderBody(
  result: ReviewRunResult,
  options: ReviewCommandOptions,
  provider: ResolvedReviewProvider | undefined,
): string {
  const format = options.format ?? "terminal";
  let output =
    format === "json"
      ? renderReviewJson(result)
      : format === "markdown"
        ? renderReviewMarkdown(result)
        : renderReviewTerminal(result);
  if (format !== "terminal") return output;
  output = `${terminalHeader(result, options, provider)}\n${output}`;
  if (options.score === true && result.score !== undefined) {
    output = `${output}\nFull score model:\n${renderScoreTerminal(result.score)}`;
  }
  return output;
}

export async function renderReviewCommandResult(
  result: ReviewRunResult,
  options: ReviewCommandOptions,
  provider?: ResolvedReviewProvider,
): Promise<ReviewCommandResult> {
  let output = renderBody(result, options, provider);
  if (options.retainTranscript === true) {
    try {
      const path = await retainReviewTranscript({
        runId: result.runId,
        body: output,
      });
      output = `${output}\nTranscript retained (sensitive): ${path}\n`;
    } catch (error) {
      output = `${output}\nTranscript retention failed: ${error instanceof Error ? error.message : "unknown error"}\n`;
    }
  }
  if (options.output !== undefined) {
    await writeFile(options.output, output, { mode: 0o600, flag: "wx" });
  }
  return {
    exitCode: gateExitCode(
      result.gate,
      result.incomplete,
      options.score === true ? result.scoreGate : undefined,
    ),
    output,
  };
}
