import { describe, expect, test } from "vitest";

import {
  createBenchmarkReport,
  evaluateBenchmark,
} from "../../../src/benchmark/evaluate.js";

describe("benchmark evaluation", () => {
  test("computes precision and recall", () => {
    const metrics = evaluateBenchmark(
      [
        { id: "a", expectedFindingIds: ["F1", "F2"] },
        { id: "b", expectedFindingIds: [] },
      ],
      [
        { id: "a", reportedFindingIds: ["F1", "F3"] },
        { id: "b", reportedFindingIds: [] },
      ],
    );
    expect(metrics.truePositives).toBe(1);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.falseNegatives).toBe(1);
    expect(metrics.precision).toBeCloseTo(0.5);
    expect(metrics.recall).toBeCloseTo(0.5);
  });

  test("reports duplicates, repeat stability, high-severity misses, and run metadata", () => {
    const report = createBenchmarkReport(
      [
        {
          id: "defect",
          expectedFindingIds: ["F1", "F2"],
          highSeverityFindingIds: ["F2"],
        },
        { id: "clean", expectedFindingIds: [] },
      ],
      [
        {
          id: "defect",
          reportedFindingIds: ["F1", "F1", "F3"],
          repeatReportedFindingIds: [["F1", "F3"], ["F1"]],
          latencyMs: 125,
          inputTokens: 80,
          outputTokens: 20,
        },
        {
          id: "clean",
          reportedFindingIds: [],
          latencyMs: 25,
          inputTokens: 10,
          outputTokens: 2,
        },
      ],
      {
        schemaVersion: "1",
        generatedAt: "2026-07-20T00:00:00.000Z",
        provider: "fixture",
        model: "deterministic",
        promptVersion: "cq-prompt-bundle/v4",
        ruleVersion: "cq-rules/1",
      },
    );

    expect(report.metrics.duplicateCount).toBe(1);
    expect(report.metrics.duplicateRate).toBeCloseTo(1 / 3);
    expect(report.metrics.repeatRunStability).toBeCloseTo(0.5);
    expect(report.metrics.highSeverityMisses).toEqual(["defect:F2"]);
    expect(report.metrics.exactCases).toBe(1);
    expect(report.metrics.partialCases).toBe(1);
    expect(report.metrics.missedCases).toBe(0);
    expect(report.resources).toEqual({
      latencyMs: 150,
      inputTokens: 90,
      outputTokens: 22,
    });
    expect(report.metadata.model).toBe("deterministic");
    expect(report.cases.map(({ outcome }) => outcome)).toEqual([
      "partial",
      "exact",
    ]);
  });
});
