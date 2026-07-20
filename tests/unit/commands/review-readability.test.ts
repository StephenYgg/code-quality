import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { analyzeTypeScriptSource } from "../../../src/analysis/typescript-analyzer.js";

const REVIEW_SOURCE = new URL(
  "../../../src/commands/review.ts",
  import.meta.url,
);

describe("review command readability ratchet", () => {
  test("keeps review execution and its semantic phases below blocking size thresholds", async () => {
    const source = await readFile(REVIEW_SOURCE, "utf8");
    const analysis = analyzeTypeScriptSource("src/commands/review.ts", source);
    const lineSpans = new Map(
      analysis.functions.map(({ name, range }) => [name, range.lineSpan]),
    );

    expect(analysis.complete).toBe(true);
    expect(lineSpans.get("executeReview")).toBeLessThan(150);
    for (const helper of [
      "prepareReviewExecution",
      "runFinalizedReview",
      "mapFlightOutcome",
    ]) {
      expect(
        lineSpans.get(helper),
        `${helper} should be a named phase`,
      ).toBeDefined();
      expect(
        lineSpans.get(helper),
        `${helper} should stay focused`,
      ).toBeLessThan(80);
    }
  });
});
