import { describe, expect, test } from "vitest";

import {
  DEFAULT_SCORE_MODEL,
  calculateScore,
  parseScoreModelDocument,
  validateScoreModelDocumentSemantics,
  type ScoreModel,
} from "../../../src/core/scoring.js";
import {
  assessmentsForModel,
  repositoryContext,
} from "./scoring-test-helpers.js";

function validDocument(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    ...JSON.parse(JSON.stringify(DEFAULT_SCORE_MODEL)),
  } as Record<string, unknown>;
}

function majors(document: Record<string, unknown>): Record<string, unknown>[] {
  const value = document.majors;
  if (!Array.isArray(value)) throw new Error("missing majors");
  return value as Record<string, unknown>[];
}

function minors(major: Record<string, unknown>): Record<string, unknown>[] {
  const value = major.minors;
  if (!Array.isArray(value)) throw new Error("missing minors");
  return value as Record<string, unknown>[];
}

describe("parseScoreModelDocument", () => {
  test("round-trips canonical JSON into a complete model usable by scoring", () => {
    const document = JSON.parse(JSON.stringify(validDocument())) as unknown;

    const model = parseScoreModelDocument(document);
    const result = calculateScore(
      model,
      assessmentsForModel(model, 4.5),
      repositoryContext(),
    );

    expect(model).toEqual(DEFAULT_SCORE_MODEL);
    expect(result.display.normalized).toBe("90.0");
    expect(result.model).toMatchObject({
      id: DEFAULT_SCORE_MODEL.id,
      version: DEFAULT_SCORE_MODEL.version,
      ruleVersions: DEFAULT_SCORE_MODEL.ruleVersions,
      roundingMode: "half_up",
    });
  });

  test("owns and recursively freezes every materialized nested value", () => {
    const document = validDocument();
    const model = parseScoreModelDocument(document);
    const documentMajors = majors(document);
    const documentMinor = minors(documentMajors[0] ?? {})[0];
    const modelMajor = model.majors[0];
    const modelMinor = modelMajor?.minors[0];
    if (documentMinor === undefined || modelMinor === undefined) {
      throw new Error("missing first minor");
    }

    documentMinor.name = "Caller mutation";
    (documentMinor.domainVocabulary as string[]).push("caller mutation");

    expect(modelMinor.name).toBe(
      DEFAULT_SCORE_MODEL.majors[0]?.minors[0]?.name,
    );
    expect(modelMinor.domainVocabulary).not.toContain("caller mutation");
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.ruleVersions)).toBe(true);
    expect(Object.isFrozen(model.majors)).toBe(true);
    expect(Object.isFrozen(modelMajor)).toBe(true);
    expect(Object.isFrozen(modelMajor?.minors)).toBe(true);
    expect(Object.isFrozen(modelMinor)).toBe(true);
    expect(Object.isFrozen(modelMinor.domainVocabulary)).toBe(true);
    expect(Object.isFrozen(modelMinor.ratingAnchors)).toBe(true);
  });

  test.each([
    ["null", null],
    ["array", []],
    ["unknown key", { ...validDocument(), extension: true }],
  ])("rejects a structurally invalid %s document", (_label, document) => {
    expect(() => parseScoreModelDocument(document)).toThrow(
      /score model document.*schema/iu,
    );
  });

  test.each([
    {
      defect: "bad grand total",
      mutate: (document: Record<string, unknown>) => {
        const first = majors(document)[0];
        if (first === undefined) throw new Error("missing major");
        first.weightTenths = 199;
      },
      code: "MAJOR_TOTAL_INVALID",
    },
    {
      defect: "bad major subtotal",
      mutate: (document: Record<string, unknown>) => {
        const first = majors(document)[0];
        const firstMinor = first === undefined ? undefined : minors(first)[0];
        if (firstMinor === undefined) throw new Error("missing minor");
        firstMinor.weightTenths = 39;
      },
      code: "MINOR_TOTAL_MISMATCH",
    },
    {
      defect: "missing standard major",
      mutate: (document: Record<string, unknown>) => {
        document.majors = majors(document).slice(1);
      },
      code: "MAJOR_SET_INVALID",
    },
    {
      defect: "unknown major",
      mutate: (document: Record<string, unknown>) => {
        const first = majors(document)[0];
        if (first === undefined) throw new Error("missing major");
        first.id = "unknown-major";
      },
      code: "MAJOR_SET_INVALID",
    },
    {
      defect: "duplicate minor IDs across majors",
      mutate: (document: Record<string, unknown>) => {
        const allMajors = majors(document);
        const source = allMajors[0];
        const target = allMajors[1];
        const sourceMinor =
          source === undefined ? undefined : minors(source)[0];
        const targetMinor =
          target === undefined ? undefined : minors(target)[0];
        if (sourceMinor === undefined || targetMinor === undefined) {
          throw new Error("missing minors");
        }
        targetMinor.id = sourceMinor.id;
      },
      code: "DUPLICATE_MINOR_ID",
    },
    {
      defect: "semantically invalid anchors",
      mutate: (document: Record<string, unknown>) => {
        const first = majors(document)[0];
        const firstMinor = first === undefined ? undefined : minors(first)[0];
        if (firstMinor === undefined) throw new Error("missing minor");
        firstMinor.ratingAnchors = {
          "0.0":
            "Intent and contract alignment: repeated anchor text is invalid.",
          "1.0":
            "Intent and contract alignment: repeated anchor text is invalid.",
          "2.0":
            "Intent and contract alignment: repeated anchor text is invalid.",
          "3.0":
            "Intent and contract alignment: repeated anchor text is invalid.",
          "4.0":
            "Intent and contract alignment: repeated anchor text is invalid.",
          "5.0":
            "Intent and contract alignment: repeated anchor text is invalid.",
        };
      },
      code: "INVALID_RATING_ANCHORS",
    },
  ])("reports and rejects a $defect", ({ mutate, code }) => {
    const document = validDocument();
    mutate(document);

    expect(validateScoreModelDocumentSemantics(document)).toContainEqual(
      expect.objectContaining({ code }),
    );
    expect(() => parseScoreModelDocument(document)).toThrow(
      /score model document.*semantic/iu,
    );
  });

  test("does not throw when the semantic hook receives unvalidated input", () => {
    expect(validateScoreModelDocumentSemantics(null)).toContainEqual(
      expect.objectContaining({ code: "INVALID_DOCUMENT_STRUCTURE" }),
    );
  });

  test("enforces the schema's per-major minor bound in the semantic hook", () => {
    const document = validDocument();
    const firstMajor = majors(document)[0];
    const firstMinor =
      firstMajor === undefined ? undefined : minors(firstMajor)[0];
    if (firstMajor === undefined || firstMinor === undefined) {
      throw new Error("missing first minor");
    }
    firstMajor.minors = [
      ...minors(firstMajor),
      ...Array.from({ length: 121 }, (_, index) => ({
        ...structuredClone(firstMinor),
        id: `repository-zero-${index.toString()}`,
        weightTenths: 0,
      })),
    ];

    expect(validateScoreModelDocumentSemantics(document)).toContainEqual(
      expect.objectContaining({ code: "MODEL_LIMIT_EXCEEDED" }),
    );
  });

  test("materializes optional profile metadata independently", () => {
    const document = validDocument();
    document.profileHash = "profile-hash";
    document.ruleVersions = { "CQ-SCORE": "2.0.0", "CQ-READ": "1.1.0" };
    const model = parseScoreModelDocument(document);

    expect(model).toMatchObject<Partial<ScoreModel>>({
      profileHash: "profile-hash",
      ruleVersions: { "CQ-SCORE": "2.0.0", "CQ-READ": "1.1.0" },
    });
    expect(model.ruleVersions).not.toBe(document.ruleVersions);
  });
});
