import { describe, expect, test } from "vitest";

import {
  DEFAULT_SCORE_MODEL,
  calculateScore,
  type Assessment,
  type ScoreModel,
} from "../../../src/core/scoring.js";
import {
  assessmentsAt,
  assessmentsForModel,
  cloneDefaultModel,
  modelWithFractionalRepositoryMinors,
  repositoryContext,
} from "./scoring-test-helpers.js";

describe("calculateScore", () => {
  test.each([
    ["null", null],
    ["array", []],
    ["missing status", { minorId: "intent-contract" }],
    ["unknown status", { minorId: "intent-contract", status: "skipped" }],
    [
      "string rating",
      {
        minorId: "intent-contract",
        status: "scored",
        rating: "5",
        confidence: "high",
        evidence: ["src/example.ts:1"],
        explanation: "Evidence exists.",
      },
    ],
    [
      "null evidence",
      {
        minorId: "intent-contract",
        status: "scored",
        rating: 5,
        confidence: "high",
        evidence: null,
        explanation: "Evidence exists.",
      },
    ],
    [
      "non-string evidence",
      {
        minorId: "intent-contract",
        status: "scored",
        rating: 5,
        confidence: "high",
        evidence: [42],
        explanation: "Evidence exists.",
      },
    ],
    [
      "extra scored field",
      {
        minorId: "intent-contract",
        status: "scored",
        rating: 5,
        confidence: "high",
        evidence: ["src/example.ts:1"],
        explanation: "Evidence exists.",
        ignored: true,
      },
    ],
    [
      "non-string not-applicable reason",
      {
        minorId: "intent-contract",
        status: "not_applicable",
        reason: 42,
      },
    ],
    [
      "null missing-evidence array",
      {
        minorId: "intent-contract",
        status: "not_assessed",
        reason: "Evidence was unavailable.",
        missingEvidence: null,
      },
    ],
  ])(
    "rejects a malformed %s assessment before scoring",
    (_label, malformed) => {
      const assessments: unknown[] = assessmentsAt(5);
      assessments[0] = malformed;

      expect(() =>
        calculateScore(
          DEFAULT_SCORE_MODEL,
          assessments as unknown as Assessment[],
          repositoryContext(),
        ),
      ).toThrow(/assessment/iu);
    },
  );

  test("rejects ratings outside 0..5 or outside 0.5 increments", () => {
    for (const rating of [-0.5, 0.1, 4.9, 5.5]) {
      const assessments = assessmentsAt(5);
      const first = assessments[0];
      if (first === undefined || first.status !== "scored") {
        throw new Error("missing assessment");
      }
      assessments[0] = { ...first, rating };

      expect(() =>
        calculateScore(DEFAULT_SCORE_MODEL, assessments, repositoryContext()),
      ).toThrow(/rating.*0\.5/iu);
    }
  });

  test("rejects an unsupported runtime confidence value", () => {
    const assessments = assessmentsAt(5);
    const first = assessments[0];
    if (first === undefined || first.status !== "scored") {
      throw new Error("missing assessment");
    }
    assessments[0] = {
      ...first,
      confidence: "certain",
    } as unknown as Assessment;

    expect(() =>
      calculateScore(DEFAULT_SCORE_MODEL, assessments, repositoryContext()),
    ).toThrow(/confidence/iu);
  });

  test("normalizes 73.0 assessed points out of 86.0 to 84.9 without hiding coverage", () => {
    const assessments = assessmentsAt(4);
    const unassessed = new Set([
      "intent-contract",
      "primary-path",
      "naming-intent-domain-language",
      "cohesion-responsibility-ownership",
    ]);
    for (let index = 0; index < assessments.length; index += 1) {
      const assessment = assessments[index];
      if (assessment === undefined || assessment.status !== "scored") continue;
      if (unassessed.has(assessment.minorId)) {
        assessments[index] = {
          minorId: assessment.minorId,
          status: "not_assessed",
          reason: "The required review was not completed.",
          missingEvidence: ["review evidence"],
        };
      }
    }
    const fivePointItems = new Set([
      "boundaries-invalid-input",
      "failure-timeout-retry-cancellation",
      "state-side-effects-idempotency",
      "function-responsibility-size",
      "control-flow-visible-stages",
    ]);
    for (let index = 0; index < assessments.length; index += 1) {
      const assessment = assessments[index];
      if (assessment === undefined || assessment.status !== "scored") continue;
      if (fivePointItems.has(assessment.minorId)) {
        assessments[index] = { ...assessment, rating: 5 };
      }
    }
    const firstTwoPointIndex = assessments.findIndex(
      (assessment) =>
        assessment.status === "scored" &&
        DEFAULT_SCORE_MODEL.majors.some((major) =>
          major.minors.some(
            (minor) =>
              minor.id === assessment.minorId && minor.weightTenths === 20,
          ),
        ),
    );
    const firstTwoPoint = assessments[firstTwoPointIndex];
    if (firstTwoPoint === undefined || firstTwoPoint.status !== "scored") {
      throw new Error("missing two-point assessment");
    }
    assessments[firstTwoPointIndex] = { ...firstTwoPoint, rating: 4.5 };

    const result = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessments,
      repositoryContext(),
    );

    expect(result.totals).toMatchObject({
      earned: 73,
      assessedMaximum: 86,
      applicableMaximum: 100,
    });
    expect(result.display).toMatchObject({
      earned: "73.0",
      assessedMaximum: "86.0",
      normalized: "84.9",
      coverage: "86.0",
    });
    expect(result.gate).toBe("INCOMPLETE");
  });

  test("sums exact values before applying half-up presentation rounding", () => {
    const model = modelWithFractionalRepositoryMinors();
    const assessments = assessmentsForModel(model, 0).map((assessment) =>
      assessment.status === "scored" &&
      assessment.minorId.startsWith("repository-fraction-")
        ? { ...assessment, rating: 0.5 }
        : assessment,
    );

    const result = calculateScore(model, assessments, repositoryContext());
    const fractionalMinorDisplays = result.majors
      .flatMap((major) => major.minors)
      .filter((minor) => minor.id.startsWith("repository-fraction-"))
      .map((minor) => minor.display.earned);

    expect(fractionalMinorDisplays).toEqual(["0.1", "0.1"]);
    expect(result.totals.earned).toBeCloseTo(0.1, 12);
    expect(result.display.earned).toBe("0.1");
    expect(result.display.normalized).toBe("0.1");
  });

  test("excludes not-applicable items from applicable points and requires reasons", () => {
    const assessments = assessmentsAt(5);
    const securityIds = new Set(
      DEFAULT_SCORE_MODEL.majors
        .find((major) => major.id === "security")
        ?.minors.map((minor) => minor.id),
    );
    const withoutSecurity = assessments.map((assessment) =>
      securityIds.has(assessment.minorId)
        ? {
            minorId: assessment.minorId,
            status: "not_applicable" as const,
            reason: "No security boundary exists in this declared scope.",
          }
        : assessment,
    );

    const result = calculateScore(
      DEFAULT_SCORE_MODEL,
      withoutSecurity,
      repositoryContext(),
    );
    expect(result.totals).toMatchObject({
      earned: 88,
      assessedMaximum: 88,
      applicableMaximum: 88,
      normalized: 100,
      coverage: 100,
    });
    expect(result.gate).toBe("PASS");

    const invalid = [...withoutSecurity];
    const firstNotApplicable = invalid.findIndex(
      (assessment) => assessment.status === "not_applicable",
    );
    invalid[firstNotApplicable] = {
      ...(invalid[firstNotApplicable] as Assessment),
      reason: "",
    } as Assessment;
    expect(() =>
      calculateScore(DEFAULT_SCORE_MODEL, invalid, repositoryContext()),
    ).toThrow(/not_applicable.*reason/iu);
  });

  test("forces INCOMPLETE only for required not-assessed items and validates missing evidence", () => {
    const model = cloneDefaultModel();
    const firstMajor = model.majors[0];
    const firstMinor = firstMajor?.minors[0];
    if (firstMajor === undefined || firstMinor === undefined) {
      throw new Error("missing first minor");
    }
    const optionalModel: ScoreModel = {
      ...model,
      majors: [
        {
          ...firstMajor,
          minors: [
            { ...firstMinor, required: false },
            ...firstMajor.minors.slice(1),
          ],
        },
        ...model.majors.slice(1),
      ],
    };
    const optionalAssessments = assessmentsForModel(optionalModel, 5);
    optionalAssessments[0] = {
      minorId: firstMinor.id,
      status: "not_assessed",
      reason: "Optional evidence was unavailable.",
      missingEvidence: ["optional benchmark"],
    };

    expect(
      calculateScore(
        optionalModel,
        optionalAssessments,
        repositoryContext({ gate: "WARN" }),
      ).gate,
    ).toBe("WARN");

    const requiredAssessments = assessmentsAt(5);
    requiredAssessments[0] = {
      minorId: firstMinor.id,
      status: "not_assessed",
      reason: "Required review was unavailable.",
      missingEvidence: ["required review"],
    };
    expect(
      calculateScore(
        DEFAULT_SCORE_MODEL,
        requiredAssessments,
        repositoryContext(),
      ).gate,
    ).toBe("INCOMPLETE");

    requiredAssessments[0] = {
      minorId: firstMinor.id,
      status: "not_assessed",
      reason: "Required review was unavailable.",
      missingEvidence: [],
    };
    expect(() =>
      calculateScore(
        DEFAULT_SCORE_MODEL,
        requiredAssessments,
        repositoryContext(),
      ),
    ).toThrow(/not_assessed.*missing evidence/iu);
  });

  test("keeps gate disposition independent from numeric score", () => {
    const blocked = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessmentsAt(5),
      repositoryContext({
        blockingFindings: [
          { id: "CQ-CONCURRENCY-001", confirmed: true, blocking: true },
        ],
      }),
    );
    const lowPass = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessmentsAt(0),
      repositoryContext(),
    );

    expect(blocked.display.normalized).toBe("100.0");
    expect(blocked.gate).toBe("BLOCK");
    expect(lowPass.display.normalized).toBe("0.0");
    expect(lowPass.gate).toBe("PASS");
  });

  test("aggregates confidence conservatively without changing the score", () => {
    const assessments = assessmentsAt(5);
    const first = assessments[0];
    if (first === undefined || first.status !== "scored") {
      throw new Error("missing assessment");
    }
    assessments[0] = { ...first, confidence: "low" };

    const result = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessments,
      repositoryContext(),
    );

    expect(result.confidence).toBe("low");
    expect(result.confidenceAggregation).toBe("minimum_assessed");
    expect(result.display.normalized).toBe("100.0");
  });

  test("reports a focused domain subtotal without claiming a repository total", () => {
    const readability = DEFAULT_SCORE_MODEL.majors.find(
      (major) => major.id === "readability",
    );
    if (readability === undefined) throw new Error("missing readability model");
    const assessments = readability.minors.map((minor) => ({
      minorId: minor.id,
      status: "scored" as const,
      rating: 4,
      confidence: "high" as const,
      evidence: [`src/example.ts:1#${minor.id}`],
      explanation: "Focused readability evidence was reviewed.",
    }));

    const result = calculateScore(DEFAULT_SCORE_MODEL, assessments, {
      scope: "focused_domain",
      focusedDomainId: "readability",
      gate: "PASS",
    });

    expect(result.scope).toBe("focused_domain");
    expect(result.focusedDomainId).toBe("readability");
    expect(result.representsRepositoryTotal).toBe(false);
    expect(result.majors.map((major) => major.id)).toEqual(["readability"]);
    expect(result.totals).toMatchObject({
      earned: 16,
      assessedMaximum: 20,
      applicableMaximum: 20,
      normalized: 80,
    });
    expect(result.display.maximumLabel).toBe("20.0 focused-domain points");
  });

  test("snapshots and freezes caller-owned assessment evidence", () => {
    const assessments = assessmentsAt(4);
    const baseline = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessments,
      repositoryContext(),
    );
    const firstResult = baseline.majors[0]?.minors[0];
    if (
      firstResult === undefined ||
      firstResult.assessment.status !== "scored"
    ) {
      throw new Error("missing scored result");
    }
    const callerAssessment = assessments[0];
    if (callerAssessment?.status !== "scored") {
      throw new Error("missing caller assessment");
    }
    const callerEvidence = callerAssessment.evidence as string[];
    (callerAssessment as { rating: number }).rating = 0;
    callerEvidence[0] = "mutated.ts:999";

    expect(firstResult.assessment.rating).toBe(4);
    expect(firstResult.assessment.evidence).toEqual([
      "src/intent-contract.ts:1",
    ]);
    expect(Object.isFrozen(firstResult.assessment)).toBe(true);
    expect(Object.isFrozen(firstResult.assessment.evidence)).toBe(true);

    const current = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessmentsAt(5),
      repositoryContext({ baseline }),
    );
    expect(current.baseline?.display.normalizedDelta).toBe("+20.0");
  });
});
