import {
  BoundedFileReadError,
  readBoundedUtf8File,
} from "../core/bounded-file.js";
import { parseScoreInputDocument } from "../core/score-input.js";
import { calculateScore, type ScoreResult } from "../core/scoring.js";
import {
  renderScoreJson,
  renderScoreTerminal,
  type ScoreFailureReport,
} from "../reporters/score.js";
import type { CommandOutputFormat, RenderedCommandResult } from "./output.js";

export const MAX_SCORE_INPUT_BYTES = 16 * 1024 * 1024;

export type ScoreCommandReport = ScoreResult | ScoreFailureReport;
export type ScoreInputReader = (
  path: string,
  maximumBytes: number,
) => Promise<string>;

function invalidReport(): ScoreFailureReport {
  return {
    gate: "BLOCK",
    diagnostics: [
      {
        code: "INVALID_SCORE_INPUT",
        message: "Score input is invalid or could not be read",
      },
    ],
  };
}

function incompleteReadReport(
  code: "FILE_CHANGED" | "FILE_LIMIT_EXCEEDED",
): ScoreFailureReport {
  return {
    gate: "INCOMPLETE",
    diagnostics: [
      {
        code,
        message: "Score input could not be captured within safety limits",
      },
    ],
  };
}

function render(
  report: ScoreCommandReport,
  format: CommandOutputFormat,
): string {
  return format === "json"
    ? renderScoreJson(report)
    : renderScoreTerminal(report);
}

function suppressUnavailableFullTotal(result: ScoreResult): ScoreResult {
  const hasRequiredAssessmentGap = result.majors.some((major) =>
    major.minors.some(
      (minor) => minor.required && minor.assessment.status === "not_assessed",
    ),
  );
  const hasAssessmentGap =
    result.scope !== "focused_domain" && hasRequiredAssessmentGap;
  if (!hasAssessmentGap) return result;
  return {
    ...result,
    representsRepositoryTotal: false,
    totals: { ...result.totals, normalized: null },
    display: {
      ...result.display,
      normalized: "N/A",
      maximumLabel:
        "Full total unavailable because required assessments are missing",
    },
  };
}

export async function runScoreCommand(
  inputPath: string,
  format: CommandOutputFormat,
  readInput: ScoreInputReader = readBoundedUtf8File,
): Promise<RenderedCommandResult<ScoreCommandReport>> {
  try {
    const source = await readInput(inputPath, MAX_SCORE_INPUT_BYTES);
    const input = parseScoreInputDocument(source);
    const baseline =
      input.baseline === undefined
        ? undefined
        : calculateScore(
            input.baseline.model,
            input.baseline.assessments,
            input.baseline.context,
          );
    const report = suppressUnavailableFullTotal(
      calculateScore(input.model, input.assessments, {
        ...input.context,
        ...(baseline === undefined ? {} : { baseline }),
      }),
    );
    return {
      exitCode:
        report.gate === "BLOCK" ? 1 : report.gate === "INCOMPLETE" ? 3 : 0,
      output: render(report, format),
      report,
    };
  } catch (error) {
    if (
      error instanceof BoundedFileReadError &&
      (error.code === "FILE_CHANGED" || error.code === "FILE_LIMIT_EXCEEDED")
    ) {
      const report = incompleteReadReport(error.code);
      return { exitCode: 3, output: render(report, format), report };
    }
    const report = invalidReport();
    return { exitCode: 2, output: render(report, format), report };
  }
}
