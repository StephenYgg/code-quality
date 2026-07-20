import { describe, expect, test } from "vitest";

import { DEFAULT_SCORE_MODEL } from "../../../src/core/scoring.js";
import {
  createAssessmentPlan,
  materializeStageAssessments,
  minorsForStage,
  unroutedAssessments,
} from "../../../src/review/assessment-plan.js";
import { buildStagePrompt } from "../../../src/review/prompts.js";
import { createReviewSnapshot } from "../../../src/core/snapshots.js";

describe("review assessment ownership", () => {
  test("keeps specialist-only security minors unrouted without a security stage", () => {
    const stages = ["universal", "readability", "testing"] as const;
    const plan = createAssessmentPlan(stages, DEFAULT_SCORE_MODEL);
    const assigned = stages.flatMap((stage) =>
      minorsForStage(plan, stage).map((minor) => minor.id),
    );
    const expected = DEFAULT_SCORE_MODEL.majors.flatMap((major) =>
      major.minors.map((minor) => minor.id),
    );

    const unrouted = unroutedAssessments(plan);
    const securityIds = DEFAULT_SCORE_MODEL.majors
      .find((major) => major.id === "security")
      ?.minors.map((minor) => minor.id);
    expect(securityIds).toBeDefined();
    expect(assigned).not.toEqual(expect.arrayContaining(securityIds ?? []));
    expect(unrouted.map((item) => item.minorId).sort()).toEqual(
      [...(securityIds ?? [])].sort(),
    );
    expect(
      unrouted.every(
        (item) =>
          item.reason.includes("security") &&
          item.missingEvidence.includes("required-stage:security|permissions"),
      ),
    ).toBe(true);
    const materializedIds = [
      ...assigned,
      ...unrouted.map((item) => item.minorId),
    ];
    expect(materializedIds).toHaveLength(expected.length);
    expect(new Set(materializedIds).size).toBe(expected.length);
    expect([...materializedIds].sort()).toEqual([...expected].sort());
    const actualStages = new Set<string>(stages);
    expect(
      [...plan.owners.values()].every((stage) => actualStages.has(stage)),
    ).toBe(true);
  });

  test("security stage uniquely owns every security minor when routed", () => {
    const stages = [
      "universal",
      "behavior",
      "readability",
      "testing",
      "concurrency",
      "security",
      "permissions",
    ] as const;
    const plan = createAssessmentPlan(stages, DEFAULT_SCORE_MODEL);
    const securityIds = DEFAULT_SCORE_MODEL.majors
      .find((major) => major.id === "security")
      ?.minors.map((minor) => minor.id);

    expect(minorsForStage(plan, "security").map((minor) => minor.id)).toEqual(
      securityIds,
    );
    expect(minorsForStage(plan, "permissions")).toEqual([]);
    expect(unroutedAssessments(plan)).toEqual([]);
    for (const minorId of securityIds ?? []) {
      expect(plan.owners.get(minorId)).toBe("security");
    }
  });

  test("materialization fails closed on a whitespace not-applicable reason", () => {
    const stages = ["universal", "security"] as const;
    const plan = createAssessmentPlan(stages, DEFAULT_SCORE_MODEL);
    const securityMinor = minorsForStage(plan, "security")[0];
    if (securityMinor === undefined) throw new Error("security minor missing");
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(40),
      files: [],
      exclusions: [],
      incomplete: false,
    });

    const result = materializeStageAssessments({
      stageId: "security",
      raw: [
        {
          minorId: securityMinor.id,
          status: "not_applicable",
          reason: " \n\t ",
        },
      ],
      plan,
      snapshot,
    });

    expect(result.assessments).toContainEqual(
      expect.objectContaining({
        minorId: securityMinor.id,
        status: "not_assessed",
      }),
    );
    expect(result.issues.join("\n")).toContain("not-applicable reason");
  });

  test("materialization trims explanations and fails closed when blank", () => {
    const stages = ["universal", "security"] as const;
    const plan = createAssessmentPlan(stages, DEFAULT_SCORE_MODEL);
    const securityMinor = minorsForStage(plan, "security")[0];
    if (securityMinor === undefined) throw new Error("security minor missing");
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(40),
      files: [{ path: "src/auth.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
    });
    const context = {
      files: [
        {
          path: "src/auth.ts",
          content: "export const authorized = true;\n",
          byteLength: 32,
          truncated: false,
        },
      ],
      totalBytes: 32,
      incomplete: false,
      exclusions: [],
    };
    const raw = (explanation: string) => [
      {
        minorId: securityMinor.id,
        status: "scored" as const,
        rating: 5,
        confidence: "high" as const,
        evidence: [
          {
            path: "src/auth.ts",
            startLine: 1,
            endLine: 1,
            sourceQuote: "export const authorized = true;",
          },
        ],
        explanation,
      },
    ];

    const blank = materializeStageAssessments({
      stageId: "security",
      raw: raw(" \n\t "),
      plan,
      snapshot,
      context,
    });
    const trimmed = materializeStageAssessments({
      stageId: "security",
      raw: raw("  Evidence is complete. \n"),
      plan,
      snapshot,
      context,
    });

    expect(blank.assessments).toContainEqual(
      expect.objectContaining({
        minorId: securityMinor.id,
        status: "not_assessed",
      }),
    );
    expect(blank.issues.join("\n")).toContain("explanation");
    expect(trimmed.assessments).toContainEqual(
      expect.objectContaining({
        minorId: securityMinor.id,
        status: "scored",
        explanation: "Evidence is complete.",
      }),
    );
  });

  test("score prompt names only the stage-owned minor IDs with names and anchors", () => {
    const stages = ["universal", "readability", "testing"] as const;
    const plan = createAssessmentPlan(stages, DEFAULT_SCORE_MODEL);
    const owned = minorsForStage(plan, "readability");
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(40),
      files: [],
      exclusions: [],
      incomplete: false,
    });

    const prompt = buildStagePrompt("readability", snapshot, undefined, owned);

    expect(prompt.systemInstructions).toContain(
      "Return exactly one assessment for every allowed minor ID",
    );
    expect(prompt.systemInstructions).toContain(
      "Return JSON only with candidates and assessments arrays",
    );
    for (const minor of owned) {
      expect(prompt.systemInstructions).toContain(minor.id);
      expect(prompt.systemInstructions).toContain(minor.name);
      expect(prompt.systemInstructions).toContain(minor.ratingAnchors["0.0"]);
      expect(prompt.systemInstructions).toContain(minor.ratingAnchors["5.0"]);
    }
    const foreign = DEFAULT_SCORE_MODEL.majors
      .flatMap((major) => major.minors)
      .find((minor) => !owned.some((item) => item.id === minor.id));
    expect(foreign).toBeDefined();
    expect(prompt.systemInstructions).not.toContain(foreign?.id);
  });
});
