export interface BenchmarkLabel {
  readonly id: string;
  readonly expectedFindingIds: readonly string[];
  readonly highSeverityFindingIds?: readonly string[];
}

export interface BenchmarkObservation {
  readonly id: string;
  readonly reportedFindingIds: readonly string[];
  readonly repeatReportedFindingIds?: readonly (readonly string[])[];
  readonly latencyMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export type BenchmarkCaseOutcome =
  "exact" | "false_positive" | "missed" | "partial";

export interface BenchmarkCaseResult {
  readonly id: string;
  readonly outcome: BenchmarkCaseOutcome;
  readonly missingFindingIds: readonly string[];
  readonly unexpectedFindingIds: readonly string[];
  readonly duplicateCount: number;
  readonly stable: boolean;
}

export interface BenchmarkMetrics {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly falsePositiveRate: number;
  readonly duplicateCount: number;
  readonly duplicateRate: number;
  readonly repeatRunStability: number;
  readonly highSeverityMisses: readonly string[];
  readonly exactCases: number;
  readonly partialCases: number;
  readonly missedCases: number;
  readonly falsePositiveCases: number;
}

export interface BenchmarkMetadata {
  readonly schemaVersion: "1";
  readonly generatedAt: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly ruleVersion: string;
}

export interface BenchmarkReport {
  readonly metadata: BenchmarkMetadata;
  readonly metrics: BenchmarkMetrics;
  readonly resources: {
    readonly latencyMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly cases: readonly BenchmarkCaseResult[];
}

export function evaluateBenchmark(
  labels: readonly BenchmarkLabel[],
  observations: readonly BenchmarkObservation[],
): BenchmarkMetrics {
  return calculateBenchmark(labels, observations).metrics;
}

export function createBenchmarkReport(
  labels: readonly BenchmarkLabel[],
  observations: readonly BenchmarkObservation[],
  metadata: BenchmarkMetadata,
): BenchmarkReport {
  const calculated = calculateBenchmark(labels, observations);
  return {
    metadata,
    metrics: calculated.metrics,
    resources: sumResources(observations),
    cases: calculated.cases,
  };
}

function calculateBenchmark(
  labels: readonly BenchmarkLabel[],
  observations: readonly BenchmarkObservation[],
): {
  readonly metrics: BenchmarkMetrics;
  readonly cases: BenchmarkCaseResult[];
} {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let duplicateCount = 0;
  let reportedCount = 0;
  let stableComparisons = 0;
  let repeatComparisons = 0;
  const highSeverityMisses: string[] = [];
  const byId = new Map(observations.map((item) => [item.id, item]));
  const cases = labels.map((label) => {
    const observation = byId.get(label.id);
    const reportedValues = observation?.reportedFindingIds ?? [];
    const expected = new Set(label.expectedFindingIds);
    const reported = new Set(reportedValues);
    const missing = [...expected].filter((id) => !reported.has(id)).sort();
    const unexpected = [...reported].filter((id) => !expected.has(id)).sort();
    const duplicates = reportedValues.length - reported.size;
    const stability = repeatStability(observation);

    truePositives += expected.size - missing.length;
    falseNegatives += missing.length;
    falsePositives += unexpected.length;
    duplicateCount += duplicates;
    reportedCount += reportedValues.length;
    stableComparisons += stability.stable;
    repeatComparisons += stability.total;
    for (const findingId of label.highSeverityFindingIds ?? []) {
      if (!reported.has(findingId)) {
        highSeverityMisses.push(`${label.id}:${findingId}`);
      }
    }
    return {
      id: label.id,
      outcome: classifyCase(expected.size, missing, unexpected, duplicates),
      missingFindingIds: missing,
      unexpectedFindingIds: unexpected,
      duplicateCount: duplicates,
      stable: stability.stable === stability.total,
    } satisfies BenchmarkCaseResult;
  });

  const exactCases = countOutcome(cases, "exact");
  const partialCases = countOutcome(cases, "partial");
  const missedCases = countOutcome(cases, "missed");
  const falsePositiveCases = countOutcome(cases, "false_positive");
  const cleanCases = labels.filter(
    ({ expectedFindingIds }) => expectedFindingIds.length === 0,
  ).length;
  return {
    cases,
    metrics: {
      truePositives,
      falsePositives,
      falseNegatives,
      precision: ratio(truePositives, truePositives + falsePositives, 1),
      recall: ratio(truePositives, truePositives + falseNegatives, 1),
      falsePositiveRate: ratio(falsePositiveCases, cleanCases, 0),
      duplicateCount,
      duplicateRate: ratio(duplicateCount, reportedCount, 0),
      repeatRunStability: ratio(stableComparisons, repeatComparisons, 1),
      highSeverityMisses: highSeverityMisses.sort(),
      exactCases,
      partialCases,
      missedCases,
      falsePositiveCases,
    },
  };
}

function repeatStability(observation: BenchmarkObservation | undefined): {
  readonly stable: number;
  readonly total: number;
} {
  const repeats = observation?.repeatReportedFindingIds ?? [];
  if (observation === undefined || repeats.length === 0) {
    return { stable: 0, total: 0 };
  }
  const expected = canonicalFindings(observation.reportedFindingIds);
  return {
    stable: repeats.filter((value) => canonicalFindings(value) === expected)
      .length,
    total: repeats.length,
  };
}

function classifyCase(
  expectedCount: number,
  missing: readonly string[],
  unexpected: readonly string[],
  duplicates: number,
): BenchmarkCaseOutcome {
  if (missing.length === 0 && unexpected.length === 0 && duplicates === 0) {
    return "exact";
  }
  if (expectedCount === 0) return "false_positive";
  if (missing.length === expectedCount) return "missed";
  return "partial";
}

function sumResources(observations: readonly BenchmarkObservation[]) {
  return observations.reduce(
    (total, observation) => ({
      latencyMs: total.latencyMs + boundedCount(observation.latencyMs),
      inputTokens: total.inputTokens + boundedCount(observation.inputTokens),
      outputTokens: total.outputTokens + boundedCount(observation.outputTokens),
    }),
    { latencyMs: 0, inputTokens: 0, outputTokens: 0 },
  );
}

function boundedCount(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function canonicalFindings(values: readonly string[]): string {
  return [...new Set(values)].sort().join("\u0000");
}

function countOutcome(
  cases: readonly BenchmarkCaseResult[],
  outcome: BenchmarkCaseOutcome,
): number {
  return cases.filter((item) => item.outcome === outcome).length;
}

function ratio(numerator: number, denominator: number, empty: number): number {
  return denominator === 0 ? empty : numerator / denominator;
}
