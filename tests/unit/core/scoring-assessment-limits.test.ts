import { describe, expect, test } from "vitest";

import {
  DEFAULT_SCORE_MODEL,
  MAX_ASSESSMENT_EVIDENCE_ITEMS as EXPORTED_MAX_EVIDENCE_ITEMS,
  MAX_ASSESSMENT_TEXT_BYTES_PER_SCORE as EXPORTED_MAX_TEXT_BYTES,
  MAX_ASSESSMENT_TEXT_CODE_POINTS as EXPORTED_MAX_TEXT_CODE_POINTS,
  calculateScore,
  type Assessment,
  type ScoredAssessment,
} from "../../../src/core/scoring.js";
import { assessmentsAt, repositoryContext } from "./scoring-test-helpers.js";

const MAX_EVIDENCE_ITEMS = 128;
const MAX_TEXT_CODE_POINTS = 10_000;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

describe("assessment resource limits", () => {
  test("exports one canonical set of limits for other input layers", () => {
    expect(EXPORTED_MAX_EVIDENCE_ITEMS).toBe(MAX_EVIDENCE_ITEMS);
    expect(EXPORTED_MAX_TEXT_CODE_POINTS).toBe(MAX_TEXT_CODE_POINTS);
    expect(EXPORTED_MAX_TEXT_BYTES).toBe(MAX_TEXT_BYTES);
  });

  test.each([
    {
      field: "evidence",
      replacement: (minorId: string): Assessment => ({
        minorId,
        status: "scored",
        rating: 5,
        confidence: "high",
        evidence: Array.from(
          { length: MAX_EVIDENCE_ITEMS + 1 },
          () => "evidence",
        ),
        explanation: "Evidence exists.",
      }),
    },
    {
      field: "missingEvidence",
      replacement: (minorId: string): Assessment => ({
        minorId,
        status: "not_assessed",
        reason: "Evidence was not collected.",
        missingEvidence: Array.from(
          { length: MAX_EVIDENCE_ITEMS + 1 },
          () => "missing evidence",
        ),
      }),
    },
  ])("rejects 129 $field entries", ({ field, replacement }) => {
    const assessments = assessmentsAt(5);
    const first = assessments[0];
    if (first === undefined) throw new Error("missing assessment");
    assessments[0] = replacement(first.minorId);

    expect(() => score(assessments)).toThrow(
      new RegExp(`${field}.*${MAX_EVIDENCE_ITEMS.toString()}`, "iu"),
    );
  });

  test.each([
    {
      field: "evidence",
      replacement: (minorId: string, oversized: string): Assessment => ({
        minorId,
        status: "scored",
        rating: 5,
        confidence: "high",
        evidence: [oversized],
        explanation: "Evidence exists.",
      }),
    },
    {
      field: "missingEvidence",
      replacement: (minorId: string, oversized: string): Assessment => ({
        minorId,
        status: "not_assessed",
        reason: "Evidence was not collected.",
        missingEvidence: [oversized],
      }),
    },
    {
      field: "explanation",
      replacement: (minorId: string, oversized: string): Assessment => ({
        minorId,
        status: "scored",
        rating: 5,
        confidence: "high",
        evidence: ["evidence"],
        explanation: oversized,
      }),
    },
    {
      field: "reason",
      replacement: (minorId: string, oversized: string): Assessment => ({
        minorId,
        status: "not_applicable",
        reason: oversized,
      }),
    },
  ])("rejects a 10001-code-point $field string", ({ field, replacement }) => {
    const assessments = assessmentsAt(5);
    const first = assessments[0];
    if (first === undefined) throw new Error("missing assessment");
    assessments[0] = replacement(
      first.minorId,
      "x".repeat(MAX_TEXT_CODE_POINTS + 1),
    );

    expect(() => score(assessments)).toThrow(
      new RegExp(
        `${field}.*${MAX_TEXT_CODE_POINTS.toString()}.*code points`,
        "iu",
      ),
    );
  });

  test("accepts exact per-field entry and Unicode code-point boundaries", () => {
    const assessments = assessmentsAt(5);
    const first = scoredAssessment(assessments, 0);
    const second = assessments[1];
    if (second === undefined) throw new Error("missing second assessment");
    assessments[0] = {
      ...first,
      evidence: Array.from({ length: MAX_EVIDENCE_ITEMS }, () => "evidence"),
      explanation: "界".repeat(MAX_TEXT_CODE_POINTS),
    };
    assessments[1] = {
      minorId: second.minorId,
      status: "not_assessed",
      reason: "界".repeat(MAX_TEXT_CODE_POINTS),
      missingEvidence: Array.from(
        { length: MAX_EVIDENCE_ITEMS },
        () => "missing evidence",
      ),
    };

    expect(score(assessments).display.normalized).toBe("100.0");
  });

  test("accepts exactly 8 MiB then rejects cross-assessment overflow", () => {
    const assessments = assessmentsAtAggregateBudget();

    expect(score(assessments).display.normalized).toBe("100.0");

    const first = scoredAssessment(assessments, 0);
    assessments[0] = { ...first, explanation: `${first.explanation}x` };
    expect(() => score(assessments)).toThrow(
      /assessment text.*aggregate UTF-8 budget.*8388608/iu,
    );
  });

  test("counts multibyte UTF-8 bytes rather than JavaScript string length", () => {
    const assessments = assessmentsAtAggregateBudget();
    const first = scoredAssessment(assessments, 0);
    const evidence = [...first.evidence];
    const asciiIndex = evidence.findIndex(
      (value) => value.length === MAX_TEXT_CODE_POINTS,
    );
    if (asciiIndex < 0) throw new Error("missing full ASCII evidence chunk");
    evidence[asciiIndex] = "界".repeat(MAX_TEXT_CODE_POINTS);
    assessments[0] = { ...first, evidence };

    expect(() => score(assessments)).toThrow(
      /assessment text.*aggregate UTF-8 budget.*8388608/iu,
    );
  });
});

function score(assessments: readonly Assessment[]) {
  return calculateScore(DEFAULT_SCORE_MODEL, assessments, repositoryContext());
}

function assessmentsAtAggregateBudget(): Assessment[] {
  const assessments = assessmentsAt(5).map((assessment) => {
    if (assessment.status !== "scored") {
      throw new Error("expected scored assessment");
    }
    return { ...assessment, evidence: ["x"], explanation: "x" };
  });
  let remainingBytes = MAX_TEXT_BYTES - assessments.length * 2;
  for (
    let index = 0;
    index < assessments.length && remainingBytes > 0;
    index += 1
  ) {
    const assessment = scoredAssessment(assessments, index);
    const evidence = [...assessment.evidence];
    while (evidence.length < MAX_EVIDENCE_ITEMS && remainingBytes > 0) {
      const bytes = Math.min(MAX_TEXT_CODE_POINTS, remainingBytes);
      evidence.push("a".repeat(bytes));
      remainingBytes -= bytes;
    }
    assessments[index] = { ...assessment, evidence };
  }
  if (remainingBytes !== 0) {
    throw new Error(
      "assessment fixtures cannot represent the aggregate budget",
    );
  }
  return assessments;
}

function scoredAssessment(
  assessments: readonly Assessment[],
  index: number,
): ScoredAssessment {
  const assessment = assessments[index];
  if (assessment?.status !== "scored") {
    throw new Error(`missing scored assessment ${index.toString()}`);
  }
  return assessment;
}
