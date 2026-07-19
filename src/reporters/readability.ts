import type {
  AnalysisWork,
  AnalysisDiagnostic,
} from "../analysis/language-analyzer.js";
import type {
  ReadabilityCandidate,
  ReadabilityGate,
} from "../analysis/readability.js";
import type { ReadabilityIdentityDiagnostic } from "../analysis/readability-baseline.js";
import { escapeTerminalField } from "./terminal-safe.js";

export interface FocusedReadabilityScore {
  readonly scope: "focused_domain";
  readonly domainId: "readability";
  readonly status: "not_assessed";
  readonly earned: "N/A";
  readonly maximum: string;
  readonly coverage: "0.0";
  readonly confidence: null;
  readonly representsRepositoryTotal: false;
  readonly reason: string;
}

export interface ReadabilityInspectionReport {
  readonly gate: ReadabilityGate;
  readonly path: string;
  readonly language?: string;
  readonly complete: boolean;
  readonly diagnostics: readonly (
    AnalysisDiagnostic | ReadabilityIdentityDiagnostic
  )[];
  readonly fileMetrics?: Readonly<Record<string, number>>;
  readonly functionsAnalyzed: number;
  readonly tryBlocksAnalyzed: number;
  readonly visitedNodes: number;
  readonly analysisWork?: AnalysisWork;
  readonly candidates: readonly ReadabilityCandidate[];
  readonly candidatesTotal: number;
  readonly diagnosticsTotal: number;
  readonly score: FocusedReadabilityScore;
}

export function renderReadabilityJson(
  report: ReadabilityInspectionReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderReadabilityTerminal(
  report: ReadabilityInspectionReport,
): string {
  const lines = [
    `Gate: ${report.gate}`,
    `Input: ${escapeTerminalField(report.path)}`,
    `Analysis complete: ${String(report.complete)}`,
    `Functions analyzed: ${String(report.functionsAnalyzed)}`,
    `Try blocks analyzed: ${String(report.tryBlocksAnalyzed)}`,
    `Candidates: ${String(report.candidates.length)}/${String(report.candidatesTotal)}`,
    `Readability score: ${report.score.earned}/${report.score.maximum}`,
    `Score coverage: ${report.score.coverage}% (${report.score.status})`,
  ];
  for (const candidate of report.candidates) {
    lines.push(
      `[${candidate.severity}] ${candidate.ruleId} ${String(candidate.range.start.line)}:${String(candidate.range.start.column)} ${escapeTerminalField(candidate.message)}`,
    );
  }
  for (const diagnostic of report.diagnostics) {
    lines.push(
      `[INCOMPLETE] ${diagnostic.code}: ${escapeTerminalField(diagnostic.message)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
