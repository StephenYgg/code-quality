export interface BenchmarkLabel {
  readonly id: string;
  readonly expectedFindingIds: readonly string[];
}

export interface BenchmarkObservation {
  readonly id: string;
  readonly reportedFindingIds: readonly string[];
}

export interface BenchmarkMetrics {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly falsePositiveRate: number;
}

export function evaluateBenchmark(
  labels: readonly BenchmarkLabel[],
  observations: readonly BenchmarkObservation[],
): BenchmarkMetrics {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let expectedTotal = 0;
  const byId = new Map(observations.map((item) => [item.id, item]));
  for (const label of labels) {
    expectedTotal += label.expectedFindingIds.length;
    const observed = byId.get(label.id);
    const reported = new Set(observed?.reportedFindingIds ?? []);
    for (const expected of label.expectedFindingIds) {
      if (reported.has(expected)) truePositives += 1;
      else falseNegatives += 1;
    }
    for (const reportedId of reported) {
      if (!label.expectedFindingIds.includes(reportedId)) falsePositives += 1;
    }
  }
  const precisionDenominator = truePositives + falsePositives;
  const recallDenominator = truePositives + falseNegatives;
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision:
      precisionDenominator === 0 ? 1 : truePositives / precisionDenominator,
    recall: recallDenominator === 0 ? 1 : truePositives / recallDenominator,
    falsePositiveRate:
      expectedTotal === 0 ? 0 : falsePositives / Math.max(expectedTotal, 1),
  };
}
