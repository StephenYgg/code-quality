import { describe, expect, test } from "vitest";

import {
  DEFAULT_SCORE_MODEL,
  calculateScore,
  type ScoreModel,
} from "../../../src/core/scoring.js";
import {
  assessmentsAt,
  assessmentsForModel,
  modelWithFractionalRepositoryMinors,
  repositoryContext,
  setAssessmentStatus,
  updateFirstMinor,
  validRatingAnchors,
} from "./scoring-test-helpers.js";

describe("score baselines", () => {
  test("computes baseline deltas only for equivalent scope, model version, and weights", () => {
    const baseline = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessmentsAt(4),
      repositoryContext(),
    );
    const current = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessmentsAt(5),
      repositoryContext({ baseline }),
    );

    expect(current.baseline).toMatchObject({
      comparable: true,
      normalizedDelta: 20,
      display: { normalizedDelta: "+20.0" },
    });
    expect(current.baseline?.minorChanges).toHaveLength(37);
    expect(
      current.baseline?.minorChanges.every(
        (change) => change.comparable && change.earnedDelta !== null,
      ),
    ).toBe(true);
    expect(
      current.baseline?.minorChanges.find(
        (change) => change.minorId === "intent-contract",
      ),
    ).toMatchObject({
      baseline: {
        status: "scored",
        rating: 4,
        earned: 3.2,
        maximum: 4,
        display: { earned: "3.2", maximum: "4.0" },
      },
      current: {
        status: "scored",
        rating: 5,
        earned: 4,
        maximum: 4,
        display: { earned: "4.0", maximum: "4.0" },
      },
      comparable: true,
      earnedDelta: 0.8,
    });
    expect(
      current.baseline?.majorChanges.find(
        (change) => change.majorId === "correctness",
      ),
    ).toMatchObject({
      baseline: {
        status: "scored",
        earned: 16,
        normalized: 80,
      },
      current: {
        status: "scored",
        earned: 20,
        normalized: 100,
      },
      comparable: true,
      normalizedDelta: 20,
    });

    const affectedSurfaceBaseline = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessmentsAt(4),
      { scope: "affected_surface", gate: "PASS" },
    );
    const wrongScope = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessmentsAt(5),
      repositoryContext({ baseline: affectedSurfaceBaseline }),
    );
    expect(wrongScope.baseline?.comparable).toBe(false);
    expect(wrongScope.baseline?.reason).toMatch(/scope/iu);
    expect(wrongScope.baseline?.normalizedDelta).toBeNull();
    expect(wrongScope.baseline?.majorChanges).toEqual([]);
    expect(wrongScope.baseline?.minorChanges).toEqual([]);

    const reweighted: ScoreModel = {
      ...modelWithFractionalRepositoryMinors(),
      version: DEFAULT_SCORE_MODEL.version,
    };
    const reweightedBaseline = calculateScore(
      reweighted,
      assessmentsForModel(reweighted, 4),
      repositoryContext(),
    );
    const wrongWeights = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessmentsAt(5),
      repositoryContext({ baseline: reweightedBaseline }),
    );
    expect(wrongWeights.baseline?.comparable).toBe(false);
    expect(wrongWeights.baseline?.reason).toMatch(/weight/iu);
  });

  test("treats reordered but otherwise identical profile weights as compatible", () => {
    const reordered: ScoreModel = {
      ...DEFAULT_SCORE_MODEL,
      majors: [...DEFAULT_SCORE_MODEL.majors]
        .reverse()
        .map((major) => ({ ...major, minors: [...major.minors].reverse() })),
    };
    const baseline = calculateScore(
      reordered,
      assessmentsForModel(reordered, 4),
      repositoryContext(),
    );

    const current = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessmentsAt(5),
      repositoryContext({ baseline }),
    );

    expect(current.baseline?.comparable).toBe(true);
    expect(current.baseline?.display.normalizedDelta).toBe("+20.0");
  });

  test.each([
    {
      mutation: "minor name",
      update: (minor: ScoreModel["majors"][number]["minors"][number]) => ({
        ...minor,
        name: `${minor.name} changed`,
      }),
    },
    {
      mutation: "requiredness",
      update: (minor: ScoreModel["majors"][number]["minors"][number]) => ({
        ...minor,
        required: !minor.required,
      }),
    },
    {
      mutation: "rating anchors",
      update: (minor: ScoreModel["majors"][number]["minors"][number]) => ({
        ...minor,
        ratingAnchors: {
          ...validRatingAnchors(minor.name),
          "5.0": `${minor.name}: changed complete-evidence definition.`,
        },
      }),
    },
    {
      mutation: "domain vocabulary",
      update: (minor: ScoreModel["majors"][number]["minors"][number]) => ({
        ...minor,
        domainVocabulary: ["changed domain vocabulary"],
        ratingAnchors: validRatingAnchors("Changed domain vocabulary"),
      }),
    },
  ])(
    "marks a same-version $mutation change as semantically non-equivalent",
    ({ update }) => {
      const baseline = calculateScore(
        DEFAULT_SCORE_MODEL,
        assessmentsAt(4),
        repositoryContext(),
      );
      const changed = updateFirstMinor(DEFAULT_SCORE_MODEL, update);
      const result = calculateScore(
        changed,
        assessmentsForModel(changed, 5),
        repositoryContext({ baseline }),
      );

      expect(result.baseline?.comparable).toBe(false);
      expect(result.baseline?.normalizedDelta).toBeNull();
      expect(result.baseline?.reason).toMatch(/semantic|model/iu);
    },
  );

  test("marks a bumped score-model version as non-equivalent", () => {
    const baseline = calculateScore(
      DEFAULT_SCORE_MODEL,
      assessmentsAt(4),
      repositoryContext(),
    );
    const bumped: ScoreModel = { ...DEFAULT_SCORE_MODEL, version: "1.0.1" };

    const result = calculateScore(
      bumped,
      assessmentsForModel(bumped, 5),
      repositoryContext({ baseline }),
    );

    expect(result.baseline?.comparable).toBe(false);
    expect(result.baseline?.normalizedDelta).toBeNull();
    expect(result.baseline?.reason).toMatch(/version/iu);
  });

  test("preserves both sides of every applicability transition without a numeric delta", () => {
    const transitions = [
      ["intent-contract", "scored", "not_applicable"],
      ["primary-path", "not_applicable", "scored"],
      ["boundaries-invalid-input", "scored", "not_assessed"],
      ["failure-timeout-retry-cancellation", "not_assessed", "scored"],
      ["state-side-effects-idempotency", "not_applicable", "not_assessed"],
      ["naming-intent-domain-language", "not_assessed", "not_applicable"],
    ] as const;
    const baselineAssessments = assessmentsAt(5);
    const currentAssessments = assessmentsAt(4);
    for (const [minorId, baselineStatus, currentStatus] of transitions) {
      setAssessmentStatus(baselineAssessments, minorId, baselineStatus);
      setAssessmentStatus(currentAssessments, minorId, currentStatus);
    }
    const stableUnscored = [
      ["control-flow-visible-stages", "not_applicable"],
      ["conditional-fallback-clarity", "not_assessed"],
    ] as const;
    for (const [minorId, status] of stableUnscored) {
      setAssessmentStatus(baselineAssessments, minorId, status);
      setAssessmentStatus(currentAssessments, minorId, status);
    }
    const baseline = calculateScore(
      DEFAULT_SCORE_MODEL,
      baselineAssessments,
      repositoryContext(),
    );
    const result = calculateScore(
      DEFAULT_SCORE_MODEL,
      currentAssessments,
      repositoryContext({ baseline }),
    );

    expect(result.baseline?.minorChanges).toHaveLength(37);
    expect(result.baseline?.majorChanges).toHaveLength(8);
    expect(result.baseline).toMatchObject({
      comparable: true,
      normalizedDelta: null,
      display: { normalizedDelta: "state changed" },
    });
    for (const [minorId, baselineStatus, currentStatus] of transitions) {
      const change = result.baseline?.minorChanges.find(
        (item) => item.minorId === minorId,
      );
      expect(change).toMatchObject({
        baseline: { status: baselineStatus },
        current: { status: currentStatus },
        comparable: false,
        comparisonReason: "assessment_status_changed",
        earnedDelta: null,
        display: { earnedDelta: "state changed" },
      });
      expect(change?.baseline.earned).toEqual(
        baselineStatus === "scored" ? expect.any(Number) : null,
      );
      expect(change?.current.earned).toEqual(
        currentStatus === "scored" ? expect.any(Number) : null,
      );
    }
    for (const [minorId, status] of stableUnscored) {
      const change = result.baseline?.minorChanges.find(
        (item) => item.minorId === minorId,
      );
      expect(change).toMatchObject({
        baseline: { status, earned: null },
        current: { status, earned: null },
        comparable: false,
        comparisonReason: `${status}_unchanged_non_numeric`,
        earnedDelta: null,
        display: {
          earnedDelta:
            status === "not_applicable"
              ? "not applicable unchanged"
              : "not assessed unchanged",
        },
      });
    }
    expect(
      result.baseline?.majorChanges.find(
        (change) => change.majorId === "correctness",
      ),
    ).toMatchObject({
      baseline: { status: "mixed" },
      current: { status: "mixed" },
      comparable: false,
      normalizedDelta: null,
      display: { normalizedDelta: "state changed" },
    });
  });
});
