import { describe, expect, test } from "vitest";

import {
  DEFAULT_SCORE_MODEL,
  calculateScore,
  validateScoreModel,
  type RatingAnchors,
  type ScoreModel,
} from "../../../src/core/scoring.js";
import {
  RATING_KEYS,
  assessmentsForModel,
  cloneDefaultModel,
  repositoryContext,
  updateFirstMinor,
  validRatingAnchors,
} from "./scoring-test-helpers.js";

const EXPECTED_DEFAULT_MODEL = [
  {
    id: "correctness",
    weightTenths: 200,
    minors: [
      ["intent-contract", 40],
      ["primary-path", 40],
      ["boundaries-invalid-input", 40],
      ["failure-timeout-retry-cancellation", 40],
      ["state-side-effects-idempotency", 40],
    ],
  },
  {
    id: "readability",
    weightTenths: 200,
    minors: [
      ["naming-intent-domain-language", 30],
      ["function-responsibility-size", 40],
      ["control-flow-visible-stages", 40],
      ["conditional-fallback-clarity", 30],
      ["try-catch-error-boundaries", 30],
      ["state-return-types-result-shapes", 30],
    ],
  },
  {
    id: "architecture",
    weightTenths: 120,
    minors: [
      ["cohesion-responsibility-ownership", 30],
      ["dependency-direction-layering", 30],
      ["public-interfaces-encapsulation", 20],
      ["shared-state-lifecycle-ownership", 20],
      ["abstraction-value-duplication", 20],
    ],
  },
  {
    id: "testing",
    weightTenths: 120,
    minors: [
      ["observable-behavior-coverage", 30],
      ["failure-boundary-coverage", 30],
      ["concurrency-timing-coverage", 20],
      ["determinism-isolation", 20],
      ["integration-contract-coverage", 20],
    ],
  },
  {
    id: "concurrency",
    weightTenths: 120,
    minors: [
      ["hot-path-amplification-capacity", 20],
      ["race-atomicity-toctou", 20],
      ["lock-scope-ownership-contention", 20],
      ["single-flight-idempotency-deduplication", 20],
      ["bounded-work-retries-queues-backpressure", 20],
      ["multi-instance-stampede-resource-bounds", 20],
    ],
  },
  {
    id: "security",
    weightTenths: 120,
    minors: [
      ["authentication-authorization-tenant-isolation", 30],
      ["input-injection-path-url-file-safety", 30],
      ["secrets-privacy-logging-retention-deletion", 30],
      ["trust-boundaries-exfiltration-least-privilege", 30],
    ],
  },
  {
    id: "compatibility",
    weightTenths: 60,
    minors: [
      ["api-event-schema-compatibility", 20],
      ["data-migration-multi-version-behavior", 20],
      ["configuration-release-rollback-deprecation", 20],
    ],
  },
  {
    id: "observability-docs-supply-chain",
    weightTenths: 60,
    minors: [
      ["errors-logs-metrics-traces-alerts", 20],
      ["documentation-repository-hygiene-operability", 20],
      ["dependencies-licenses-provenance-release-integrity", 20],
    ],
  },
] as const;

describe("DEFAULT_SCORE_MODEL", () => {
  test("contains the exact eight majors and every named standard minor", () => {
    expect(
      DEFAULT_SCORE_MODEL.majors.map((major) => ({
        id: major.id,
        weightTenths: major.weightTenths,
        minors: major.minors.map((minor) => [minor.id, minor.weightTenths]),
      })),
    ).toEqual(EXPECTED_DEFAULT_MODEL);
    expect(
      DEFAULT_SCORE_MODEL.majors.every((major) => major.name.length > 0),
    ).toBe(true);
    expect(
      DEFAULT_SCORE_MODEL.majors
        .flatMap((major) => major.minors)
        .every((minor) => minor.name.length > 0 && minor.required),
    ).toBe(true);
    expect(validateScoreModel(DEFAULT_SCORE_MODEL)).toEqual([]);
  });

  test("provides six substantive domain-specific integer rating anchors per minor", () => {
    const expectedKeys = ["0.0", "1.0", "2.0", "3.0", "4.0", "5.0"] as const;

    for (const minor of DEFAULT_SCORE_MODEL.majors.flatMap(
      (major) => major.minors,
    )) {
      const anchors = minor.ratingAnchors;
      expect(Object.keys(anchors).sort()).toEqual(expectedKeys);
      const anchorValues = expectedKeys.map((key) => anchors[key]);
      expect(new Set(anchorValues)).toHaveLength(6);
      for (const anchor of anchorValues) {
        expect(anchor).toContain(minor.name);
        expect(anchor.length).toBeGreaterThanOrEqual(40);
        expect(anchor).not.toMatch(/todo|tbd|placeholder/iu);
      }
    }
  });

  test("recursively freezes every nested default model value", () => {
    const firstMajor = DEFAULT_SCORE_MODEL.majors[0];
    const firstMinor = firstMajor?.minors[0];
    if (firstMajor === undefined || firstMinor === undefined) {
      throw new Error("missing default minor");
    }

    expect(Object.isFrozen(DEFAULT_SCORE_MODEL)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SCORE_MODEL.ruleVersions)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SCORE_MODEL.majors)).toBe(true);
    expect(Object.isFrozen(firstMajor)).toBe(true);
    expect(Object.isFrozen(firstMajor.minors)).toBe(true);
    expect(Object.isFrozen(firstMinor)).toBe(true);
    expect(Object.isFrozen(firstMinor.domainVocabulary)).toBe(true);
    expect(Object.isFrozen(firstMinor.ratingAnchors)).toBe(true);
    expect(() =>
      (firstMinor.domainVocabulary as string[]).push("mutated-domain"),
    ).toThrow(TypeError);
    expect(() => {
      (firstMinor.ratingAnchors as { "0.0": string })["0.0"] = "mutated";
    }).toThrow(TypeError);
  });

  test("remains deterministic across call order and concurrent Promise callers", async () => {
    const assessments = assessmentsForModel(DEFAULT_SCORE_MODEL, 4);
    const before = JSON.stringify(DEFAULT_SCORE_MODEL);
    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        Promise.resolve(
          calculateScore(DEFAULT_SCORE_MODEL, assessments, repositoryContext()),
        ),
      ),
    );
    expect(results.map((result) => result.display.normalized)).toEqual(
      Array.from({ length: 32 }, () => "80.0"),
    );
    expect(JSON.stringify(DEFAULT_SCORE_MODEL)).toBe(before);
    expect(validateScoreModel(DEFAULT_SCORE_MODEL)).toEqual([]);
  });
});

describe("validateScoreModel", () => {
  test("rejects major and minor totals that are not exact integer tenths", () => {
    const model = cloneDefaultModel();
    const firstMajor = model.majors[0];
    if (firstMajor === undefined) throw new Error("missing default major");
    const invalid: ScoreModel = {
      ...model,
      majors: [{ ...firstMajor, weightTenths: 199 }, ...model.majors.slice(1)],
    };

    expect(validateScoreModel(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MAJOR_TOTAL_INVALID" }),
        expect.objectContaining({ code: "MINOR_TOTAL_MISMATCH" }),
      ]),
    );

    const fractionalTenths: ScoreModel = {
      ...model,
      majors: [
        { ...firstMajor, weightTenths: 199.5 },
        ...model.majors.slice(1),
      ],
    };
    expect(validateScoreModel(fractionalTenths)).toContainEqual(
      expect.objectContaining({ code: "INVALID_MAJOR_WEIGHT" }),
    );
  });

  test("rejects duplicate IDs and unnamed remainder items", () => {
    const model = cloneDefaultModel();
    const firstMajor = model.majors[0];
    const secondMajor = model.majors[1];
    const firstMinor = firstMajor?.minors[0];
    if (
      firstMajor === undefined ||
      secondMajor === undefined ||
      firstMinor === undefined
    ) {
      throw new Error("incomplete default model");
    }
    const invalid: ScoreModel = {
      ...model,
      majors: [
        {
          ...firstMajor,
          name: " ",
          minors: [{ ...firstMinor, name: "" }, ...firstMajor.minors.slice(1)],
        },
        { ...secondMajor, id: firstMajor.id },
        ...model.majors.slice(2),
      ],
    };

    expect(validateScoreModel(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNNAMED_MAJOR" }),
        expect.objectContaining({ code: "UNNAMED_MINOR" }),
        expect.objectContaining({ code: "DUPLICATE_MAJOR_ID" }),
      ]),
    );
  });

  test("accepts versioned profile overrides and repository-specific named minors", () => {
    const model = cloneDefaultModel("profile-2");
    const observability = model.majors.at(-1);
    const firstMinor = observability?.minors[0];
    if (observability === undefined || firstMinor === undefined) {
      throw new Error("missing observability model");
    }
    const overridden: ScoreModel = {
      ...model,
      profileHash: "profile-sha256",
      majors: [
        ...model.majors.slice(0, -1),
        {
          ...observability,
          minors: [
            { ...firstMinor, weightTenths: 10 },
            ...observability.minors.slice(1),
            {
              id: "repository-runbook-quality",
              name: "Repository runbook quality",
              weightTenths: 10,
              required: false,
              domainVocabulary: ["repository runbook"],
              ratingAnchors: validRatingAnchors("Repository runbook quality"),
            },
          ],
        },
      ],
    };

    expect(validateScoreModel(overridden)).toEqual([]);
    expect(
      calculateScore(
        overridden,
        assessmentsForModel(overridden, 5),
        repositoryContext(),
      ).model.version,
    ).toBe("profile-2");
  });

  test("rejects models whose repository-specific minors exceed the hard bound", () => {
    const model = cloneDefaultModel();
    const firstMajor = model.majors[0];
    if (firstMajor === undefined) throw new Error("missing default major");
    const excessiveMinors = Array.from({ length: 1_001 }, (_, index) => ({
      id: `repository-zero-${index.toString()}`,
      name: `Repository zero ${index.toString()}`,
      weightTenths: 0,
      required: false,
      domainVocabulary: ["repository zero"],
      ratingAnchors: validRatingAnchors("Repository zero"),
    }));
    const excessive: ScoreModel = {
      ...model,
      majors: [
        { ...firstMajor, minors: [...firstMajor.minors, ...excessiveMinors] },
        ...model.majors.slice(1),
      ],
    };

    expect(validateScoreModel(excessive)).toContainEqual(
      expect.objectContaining({ code: "MODEL_LIMIT_EXCEEDED" }),
    );
  });

  test.each([
    {
      defect: "missing required key",
      anchors: {
        "0.0": "Domain: confirmed failure prevents reliable review.",
        "1.0": "Domain: severe structural failure remains prevalent.",
        "2.0": "Domain: key behavior remains difficult to prove.",
        "3.0": "Domain: material evidence gaps remain unresolved.",
        "4.0": "Domain: only a small evidence gap remains.",
      },
    },
    {
      defect: "extra half-step key",
      anchors: {
        ...validRatingAnchors("Domain"),
        "2.5": "Half-step anchors belong in the assessment explanation.",
      },
    },
    {
      defect: "placeholder value",
      anchors: { ...validRatingAnchors("Domain"), "3.0": "TODO" },
    },
    {
      defect: "blank value",
      anchors: { ...validRatingAnchors("Domain"), "4.0": "  " },
    },
  ])("rejects rating anchors with a $defect", ({ anchors }) => {
    const invalid = updateFirstMinor(DEFAULT_SCORE_MODEL, (minor) => ({
      ...minor,
      ratingAnchors: anchors as unknown as RatingAnchors,
    }));

    expect(validateScoreModel(invalid)).toContainEqual(
      expect.objectContaining({ code: "INVALID_RATING_ANCHORS" }),
    );
  });

  test.each([
    {
      defect: "identical values",
      anchors: Object.fromEntries(
        RATING_KEYS.map((key) => [
          key,
          "Intent and contract alignment: repeated evidence text for every rating.",
        ]),
      ),
    },
    {
      defect: "trivially short values",
      anchors: Object.fromEntries(
        RATING_KEYS.map((key) => [key, `intent ${key}`]),
      ),
    },
    {
      defect: "generic unrelated values",
      anchors: Object.fromEntries(
        RATING_KEYS.map((key) => [
          key,
          `Garden irrigation schedule number ${key} has detailed seasonal watering notes.`,
        ]),
      ),
    },
    {
      defect: "template text",
      anchors: Object.fromEntries(
        RATING_KEYS.map((key) => [
          key,
          `Intent and contract alignment: template rating ${key} should be replaced later.`,
        ]),
      ),
    },
  ])("rejects $defect even when all six rating keys exist", ({ anchors }) => {
    const invalid = updateFirstMinor(DEFAULT_SCORE_MODEL, (minor) => ({
      ...minor,
      ratingAnchors: anchors as unknown as RatingAnchors,
    }));

    expect(validateScoreModel(invalid)).toContainEqual(
      expect.objectContaining({ code: "INVALID_RATING_ANCHORS" }),
    );
  });

  test("accepts distinct substantive anchors tied to a repository domain", () => {
    const valid = updateFirstMinor(DEFAULT_SCORE_MODEL, (minor) => ({
      ...minor,
      name: "Payment settlement integrity",
      domainVocabulary: ["payout reconciliation", "settlement ledger"],
      ratingAnchors: validRatingAnchors("Payout reconciliation"),
    }));

    expect(validateScoreModel(valid)).toEqual([]);
  });

  test("accepts vocabulary and anchor values at every schema resource maximum", () => {
    const maximumTerm = "d".repeat(160);
    const domainVocabulary = [
      maximumTerm,
      ...Array.from(
        { length: 31 },
        (_, index) => `secondary-domain-${index.toString()}`,
      ),
    ];
    const anchors = validRatingAnchors(maximumTerm);
    const valid = updateFirstMinor(DEFAULT_SCORE_MODEL, (minor) => ({
      ...minor,
      domainVocabulary,
      ratingAnchors: {
        ...anchors,
        "5.0": paddedText(`${maximumTerm}: `, 2_000),
      },
    }));

    expect(validateScoreModel(valid)).toEqual([]);
  });

  test.each([
    {
      defect: "33 domain vocabulary entries",
      update: {
        domainVocabulary: Array.from(
          { length: 33 },
          (_, index) => `bounded-domain-${index.toString()}`,
        ),
        ratingAnchors: validRatingAnchors("bounded-domain-0"),
      },
      code: "INVALID_DOMAIN_VOCABULARY",
    },
    {
      defect: "a 161-code-point domain term",
      update: {
        domainVocabulary: ["d".repeat(161)],
        ratingAnchors: validRatingAnchors("d".repeat(161)),
      },
      code: "INVALID_DOMAIN_VOCABULARY",
    },
    {
      defect: "a 2001-code-point rating anchor",
      update: {
        domainVocabulary: ["bounded domain"],
        ratingAnchors: {
          ...validRatingAnchors("bounded domain"),
          "5.0": paddedText("bounded domain: ", 2_001),
        },
      },
      code: "INVALID_RATING_ANCHORS",
    },
    {
      defect:
        "a 161-code-point domain term that whitespace normalization shrinks",
      update: {
        domainVocabulary: [`bounded${" ".repeat(148)}domain`],
        ratingAnchors: validRatingAnchors("bounded domain"),
      },
      code: "INVALID_DOMAIN_VOCABULARY",
    },
    {
      defect: "a 2001-code-point anchor that whitespace normalization shrinks",
      update: {
        domainVocabulary: ["bounded domain"],
        ratingAnchors: {
          ...validRatingAnchors("bounded domain"),
          "5.0": whitespacePaddedText(
            "bounded domain:",
            "complete evidence remains available.",
            2_001,
          ),
        },
      },
      code: "INVALID_RATING_ANCHORS",
    },
  ])("rejects $defect", ({ update, code }) => {
    const invalid = updateFirstMinor(DEFAULT_SCORE_MODEL, (minor) => ({
      ...minor,
      ...update,
    }));

    expect(validateScoreModel(invalid)).toContainEqual(
      expect.objectContaining({ code }),
    );
  });
});

function paddedText(prefix: string, codePointLength: number): string {
  const remaining = codePointLength - Array.from(prefix).length;
  if (remaining < 0) throw new Error("prefix exceeds requested length");
  return `${prefix}${"x".repeat(remaining)}`;
}

function whitespacePaddedText(
  prefix: string,
  suffix: string,
  codePointLength: number,
): string {
  const remaining =
    codePointLength - Array.from(prefix).length - Array.from(suffix).length;
  if (remaining < 1) throw new Error("text exceeds requested length");
  return `${prefix}${" ".repeat(remaining)}${suffix}`;
}
