import {
  DEFAULT_ANALYSIS_LIMITS,
  type AnalysisDiagnostic,
} from "../analysis/language-analyzer.js";
import {
  evaluateReadability,
  metricSnapshot,
} from "../analysis/readability.js";
import { createTypeScriptAnalyzer } from "../analysis/typescript-analyzer.js";
import {
  BoundedFileReadError,
  readBoundedUtf8File,
} from "../core/bounded-file.js";
import { DEFAULT_SCORE_MODEL } from "../core/scoring.js";
import {
  renderReadabilityJson,
  renderReadabilityTerminal,
  type FocusedReadabilityScore,
  type ReadabilityInspectionReport,
} from "../reporters/readability.js";
import type { CommandOutputFormat, RenderedCommandResult } from "./output.js";

export const MAX_READABILITY_REPORT_ITEMS = 128;

function focusedScore(): FocusedReadabilityScore {
  const major = DEFAULT_SCORE_MODEL.majors.find(
    (candidate) => candidate.id === "readability",
  );
  if (major === undefined) {
    throw new Error("Default score model has no readability domain");
  }
  return {
    scope: "focused_domain",
    domainId: "readability",
    status: "not_assessed",
    earned: "N/A",
    maximum: (major.weightTenths / 10).toFixed(1),
    coverage: "0.0",
    confidence: null,
    representsRepositoryTotal: false,
    reason:
      "Deterministic readability candidates are not semantic score assessments",
  };
}

function incompleteReport(
  path: string,
  diagnostic: AnalysisDiagnostic,
  gate: "BLOCK" | "INCOMPLETE" = "INCOMPLETE",
): ReadabilityInspectionReport {
  return {
    gate,
    path,
    complete: false,
    diagnostics: [diagnostic],
    functionsAnalyzed: 0,
    tryBlocksAnalyzed: 0,
    visitedNodes: 0,
    candidates: [],
    candidatesTotal: 0,
    diagnosticsTotal: 1,
    score: focusedScore(),
  };
}

function render(
  report: ReadabilityInspectionReport,
  format: CommandOutputFormat,
): string {
  return format === "json"
    ? renderReadabilityJson(report)
    : renderReadabilityTerminal(report);
}

export async function runReadabilityInspectCommand(
  path: string,
  format: CommandOutputFormat,
): Promise<RenderedCommandResult<ReadabilityInspectionReport>> {
  const analyzer = createTypeScriptAnalyzer();
  if (!analyzer.supports(path)) {
    const report = incompleteReport(path, {
      code: "UNSUPPORTED_LANGUAGE",
      category: "incomplete",
      path,
      message: "No deterministic readability analyzer supports this input",
    });
    return { exitCode: 3, output: render(report, format), report };
  }
  try {
    const source = await readBoundedUtf8File(
      path,
      DEFAULT_ANALYSIS_LIMITS.maxBytes,
    );
    const analysis = analyzer.analyze({ path, source });
    const readability = evaluateReadability(analysis);
    const allDiagnostics = [
      ...analysis.diagnostics,
      ...readability.diagnostics,
    ];
    const resultLimitExceeded =
      readability.candidates.length > MAX_READABILITY_REPORT_ITEMS ||
      allDiagnostics.length > MAX_READABILITY_REPORT_ITEMS;
    const diagnostics = resultLimitExceeded
      ? [
          ...allDiagnostics.slice(0, MAX_READABILITY_REPORT_ITEMS - 1),
          {
            code: "READABILITY_RESULT_LIMIT_EXCEEDED",
            category: "incomplete" as const,
            path,
            message:
              "Readability result exceeded the bounded report item limit",
          },
        ]
      : allDiagnostics;
    const report: ReadabilityInspectionReport = {
      gate: resultLimitExceeded ? "INCOMPLETE" : readability.gate,
      path,
      language: analysis.language,
      complete: analysis.complete && !resultLimitExceeded,
      diagnostics,
      fileMetrics: metricSnapshot(analysis.file),
      functionsAnalyzed: analysis.functions.length,
      tryBlocksAnalyzed: analysis.tryBlocks.length,
      visitedNodes: analysis.visitedNodes,
      analysisWork: analysis.analysisWork,
      candidates: readability.candidates.slice(0, MAX_READABILITY_REPORT_ITEMS),
      candidatesTotal: readability.candidates.length,
      diagnosticsTotal: allDiagnostics.length + (resultLimitExceeded ? 1 : 0),
      score: focusedScore(),
    };
    return {
      exitCode:
        report.gate === "BLOCK" ? 1 : report.gate === "INCOMPLETE" ? 3 : 0,
      output: render(report, format),
      report,
    };
  } catch (error) {
    const incomplete =
      error instanceof BoundedFileReadError &&
      (error.code === "FILE_CHANGED" || error.code === "FILE_LIMIT_EXCEEDED");
    const report = incompleteReport(
      path,
      {
        code: incomplete ? error.code : "INVALID_READABILITY_INPUT",
        category: "incomplete",
        path,
        message: incomplete
          ? "Readability input could not be captured within safety limits"
          : "Readability input is invalid or could not be read",
      },
      incomplete ? "INCOMPLETE" : "BLOCK",
    );
    return {
      exitCode: incomplete ? 3 : 2,
      output: render(report, format),
      report,
    };
  }
}
