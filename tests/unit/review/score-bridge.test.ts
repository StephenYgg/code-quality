import { describe, expect, test } from "vitest";

import { createFinding } from "../../../src/core/findings.js";
import {
  DEFAULT_SCORE_MODEL,
  MAX_ASSESSMENT_EVIDENCE_ITEMS,
  type Assessment,
} from "../../../src/core/scoring.js";
import { createReviewSnapshot } from "../../../src/core/snapshots.js";
import type { ReviewRunResult } from "../../../src/review/orchestrator.js";
import {
  assessmentsFromReview,
  minorForFinding,
  scoreFromReview,
} from "../../../src/review/score-bridge.js";

function baseResult(overrides: Partial<ReviewRunResult> = {}): ReviewRunResult {
  const snapshot = createReviewSnapshot({
    inputKind: "staged",
    scope: "change",
    repository: "/tmp/repo",
    head: "a".repeat(40),
    files: [{ path: "src/a.ts", status: "modified", binary: false }],
    exclusions: [],
    incomplete: false,
  });
  return {
    runId: "00000000-0000-4000-8000-000000000099",
    gate: "PASS",
    findings: [],
    corroborated: [],
    uncertain: [],
    waived: [],
    plan: {
      stages: [
        "universal",
        "behavior",
        "readability",
        "testing",
        "concurrency",
      ],
      signals: {},
      maxInFlight: 2,
      maxAttempts: 16,
      execution: "full",
    },
    snapshot,
    incomplete: false,
    providerAttempts: 2,
    promptBundleVersion: "cq-prompt-bundle/v2",
    reportHash: "b".repeat(64),
    contentBundleHash: "c".repeat(64),
    assessments: [],
    scoreGate: "PASS",
    contextIncomplete: false,
    ...overrides,
  };
}

function completeAssessments(rating = 5): readonly Assessment[] {
  return DEFAULT_SCORE_MODEL.majors.flatMap((major) =>
    major.minors.map((minor) => ({
      minorId: minor.id,
      status: "scored" as const,
      rating,
      confidence: "high" as const,
      evidence: [`src/a.ts:1-1:export const a = 1;`],
      explanation: "The rating is supported by the immutable captured range.",
    })),
  );
}

describe("score bridge full model", () => {
  test("does not turn an empty candidate review into positive assessments", () => {
    const assessments = assessmentsFromReview(baseResult());
    const expected = DEFAULT_SCORE_MODEL.majors.flatMap((major) =>
      major.minors.map((minor) => minor.id),
    );
    expect(assessments.map((item) => item.minorId).sort()).toEqual(
      [...expected].sort(),
    );
    expect(assessments.every((item) => item.status === "not_assessed")).toBe(
      true,
    );
  });

  test("incomplete review marks all minors not_assessed", () => {
    const assessments = assessmentsFromReview(
      baseResult({ incomplete: true, providerAttempts: 0, gate: "INCOMPLETE" }),
    );
    expect(assessments.every((item) => item.status === "not_assessed")).toBe(
      true,
    );
  });

  test("scoreFromReview produces a 100.0 path only from explicit complete assessments", () => {
    const score = scoreFromReview(
      baseResult({ assessments: completeAssessments() }),
    );
    expect(score.model.id).toBe("cq-default");
    expect(score.scope).toBe("change");
    expect(score.majors.length).toBe(DEFAULT_SCORE_MODEL.majors.length);
    expect(score.display.applicableMaximum).toBe("100.0");
    expect(score.totals.normalized).not.toBeNull();
    expect(score.gate).toBe("PASS");
  });

  test("marks an unrouted security minor not_assessed instead of inventing coverage", () => {
    const securityMinor = DEFAULT_SCORE_MODEL.majors.find(
      (major) => major.id === "security",
    )?.minors[0];
    if (securityMinor === undefined) throw new Error("security model missing");
    const assessments = completeAssessments().filter(
      (assessment) => assessment.minorId !== securityMinor.id,
    );

    const materialized = assessmentsFromReview(baseResult({ assessments }));

    expect(materialized).toContainEqual(
      expect.objectContaining({
        minorId: securityMinor.id,
        status: "not_assessed",
      }),
    );
    const score = scoreFromReview(baseResult({ assessments }));
    expect(score.gate).toBe("INCOMPLETE");
    expect(score.display.coverage).not.toBe("100.0");
    expect(score.display.normalized).toBe("N/A");
  });

  test.each([
    [
      "duplicate",
      (items: readonly Assessment[]) => {
        const first = items[0];
        return first === undefined ? items : [...items, first];
      },
    ],
    [
      "extra",
      (items: readonly Assessment[]) => [
        ...items,
        {
          minorId: "invented-minor",
          status: "not_applicable" as const,
          reason: "Invented IDs are not part of the score model.",
        },
      ],
    ],
  ])(
    "fails closed on an otherwise complete %s assessment set",
    (_label, mutate) => {
      const assessments = assessmentsFromReview(
        baseResult({ assessments: mutate(completeAssessments()) }),
      );
      expect(assessments.some((item) => item.status === "not_assessed")).toBe(
        true,
      );
    },
  );

  test("blocking findings lower mapped minors and can keep BLOCK gate", () => {
    const finding = createFinding({
      id: "f-block",
      title: "Auth bypass on delete",
      severity: "P1",
      disposition: "new",
      confidence: "high",
      stages: ["security"],
      lifecycle: "confirmed",
      evidence: "src/auth.ts skips owner checks on delete path",
      impact: "cross-tenant delete possible",
      remediation: "enforce owner checks server-side",
      location: { path: "src/auth.ts", startLine: 10, endLine: 20 },
    });
    expect(minorForFinding(finding)).toBe(
      "authentication-authorization-tenant-isolation",
    );
    const result = baseResult({
      findings: [finding],
      gate: "BLOCK",
      assessments: completeAssessments(5),
    });
    const assessments = assessmentsFromReview(result);
    const mapped = assessments.find(
      (item) =>
        item.minorId === "authentication-authorization-tenant-isolation",
    );
    expect(mapped?.status).toBe("scored");
    if (mapped?.status === "scored") {
      expect(mapped.rating).toBe(1);
    }
    const score = scoreFromReview(result);
    expect(score.gate).toBe("BLOCK");
    const security = score.majors.find((major) => major.id === "security");
    expect(security).toBeDefined();
    const auth = security?.minors.find(
      (minor) => minor.id === "authentication-authorization-tenant-isolation",
    );
    expect(auth?.assessment.status).toBe("scored");
    if (auth?.assessment.status === "scored") {
      expect(auth.assessment.rating).toBe(1);
    }
  });

  test("required evidence gap takes ScoreGate precedence without changing Behavior Gate BLOCK", () => {
    const finding = createFinding({
      id: "f-block-gap",
      title: "Auth bypass with incomplete score evidence",
      severity: "P1",
      disposition: "new",
      confidence: "high",
      stages: ["security"],
      lifecycle: "confirmed",
      evidence: "The confirmed access path skips its authorization check.",
      impact: "A caller may cross an authorization boundary.",
      remediation: "Enforce authorization before resource access.",
      location: { path: "src/auth.ts", startLine: 1, endLine: 1 },
    });
    const missingMinor = "documentation-repository-hygiene-operability";
    const result = baseResult({
      gate: "BLOCK",
      findings: [finding],
      assessments: completeAssessments().filter(
        (assessment) => assessment.minorId !== missingMinor,
      ),
    });

    const score = scoreFromReview(result);

    expect(result.gate).toBe("BLOCK");
    expect(score.gate).toBe("INCOMPLETE");
    expect(score.display.normalized).toBe("N/A");
    const assessedMinor = score.majors
      .flatMap((major) => major.minors)
      .find((minor) => minor.id === missingMinor);
    expect(assessedMinor?.assessment.status).toBe("not_assessed");
  });

  test("bounds deterministic finding evidence while severity cap uses every finding", () => {
    const findings = Array.from(
      { length: MAX_ASSESSMENT_EVIDENCE_ITEMS + 12 },
      (_, index) =>
        createFinding({
          id: `finding-${index.toString().padStart(3, "0")}`,
          title: `Authorization finding ${index.toString()}`,
          severity: index === MAX_ASSESSMENT_EVIDENCE_ITEMS + 11 ? "P0" : "P3",
          disposition: "new",
          confidence: "high",
          stages: ["security"],
          lifecycle: "confirmed",
          evidence: `Authorization evidence ${index.toString()}`,
          impact: "A resource access may cross an authorization boundary.",
          remediation: "Enforce authorization before resource access.",
          location: {
            path: "src/auth.ts",
            startLine: index + 1,
            endLine: index + 1,
          },
        }),
    );
    const duplicates = [findings[5], findings[7]].filter(
      (finding) => finding !== undefined,
    );
    const result = baseResult({
      findings: [...findings, ...duplicates],
      gate: "BLOCK",
      assessments: completeAssessments(5),
    });

    const forward = assessmentsFromReview(result);
    const reverse = assessmentsFromReview({
      ...result,
      findings: [...result.findings].reverse(),
    });
    const mapped = forward.find(
      (assessment) =>
        assessment.minorId === "authentication-authorization-tenant-isolation",
    );
    const reversed = reverse.find(
      (assessment) => assessment.minorId === mapped?.minorId,
    );

    expect(mapped?.status).toBe("scored");
    if (mapped?.status !== "scored") return;
    expect(mapped.rating).toBe(0);
    expect(mapped.evidence).toHaveLength(MAX_ASSESSMENT_EVIDENCE_ITEMS);
    expect(new Set(mapped.evidence).size).toBe(mapped.evidence.length);
    expect(mapped.evidence.at(-1)).toMatch(/omitted .* evidence item/u);
    expect(reversed?.status).toBe("scored");
    if (reversed?.status === "scored") {
      expect(reversed.evidence).toEqual(mapped.evidence);
      expect(reversed.rating).toBe(0);
    }
    expect(() => scoreFromReview(result)).not.toThrow();
  });
});
