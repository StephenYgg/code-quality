import { describe, expect, test } from "vitest";

import { evaluateBenchmark } from "../../../src/benchmark/evaluate.js";

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
});
