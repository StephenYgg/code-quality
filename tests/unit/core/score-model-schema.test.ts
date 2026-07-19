import { describe, expect, test } from "vitest";

import { DEFAULT_SCORE_MODEL } from "../../../src/core/scoring.js";
import { validatePolicyDocument } from "../../../src/core/policy.js";

function validScoreModelDocument(): Record<string, unknown> {
  return {
    schemaVersion: "1",
    ...JSON.parse(JSON.stringify(DEFAULT_SCORE_MODEL)),
  } as Record<string, unknown>;
}

function firstMinor(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const major = firstMajor(document);
  const minors: unknown = major.minors;
  if (!Array.isArray(minors)) throw new Error("missing minors");
  const minor: unknown = minors[0];
  if (typeof minor !== "object" || minor === null) {
    throw new Error("missing minor");
  }
  return minor as Record<string, unknown>;
}

function firstMajor(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const majors = document.majors;
  if (!Array.isArray(majors)) throw new Error("missing majors");
  const major: unknown = majors[0];
  if (typeof major !== "object" || major === null) {
    throw new Error("missing major");
  }
  return major as Record<string, unknown>;
}

describe("score-model schema", () => {
  test("accepts the canonical external representation of the runtime model", () => {
    expect(
      validatePolicyDocument(
        "score-model",
        validScoreModelDocument(),
        "score-model.json",
      ),
    ).toEqual([]);
  });

  test.each([
    {
      field: "dimensions",
      path: "/dimensions",
      mutate: (document: Record<string, unknown>) => {
        document.dimensions = document.majors;
      },
    },
    {
      field: "title",
      path: "/majors/0/title",
      mutate: (document: Record<string, unknown>) => {
        firstMajor(document).title = "Legacy major title";
      },
    },
    {
      field: "items",
      path: "/majors/0/items",
      mutate: (document: Record<string, unknown>) => {
        const major = firstMajor(document);
        major.items = major.minors;
      },
    },
  ])("rejects the legacy $field field", ({ path, mutate }) => {
    const document = validScoreModelDocument();
    mutate(document);

    expect(
      validatePolicyDocument("score-model", document, "score-model.json"),
    ).toContainEqual(expect.objectContaining({ code: "SCHEMA_INVALID", path }));
  });

  test.each([
    {
      defect: "missing domain vocabulary",
      mutate: (minor: Record<string, unknown>) => {
        delete minor.domainVocabulary;
      },
      path: "/majors/0/minors/0/domainVocabulary",
    },
    {
      defect: "duplicate domain vocabulary",
      mutate: (minor: Record<string, unknown>) => {
        minor.domainVocabulary = ["contract", "contract"];
      },
      path: "/majors/0/minors/0/domainVocabulary",
    },
    {
      defect: "blank domain vocabulary",
      mutate: (minor: Record<string, unknown>) => {
        minor.domainVocabulary = ["   "];
      },
      path: "/majors/0/minors/0/domainVocabulary/0",
    },
    {
      defect: "unbounded domain vocabulary",
      mutate: (minor: Record<string, unknown>) => {
        minor.domainVocabulary = Array.from(
          { length: 33 },
          (_, index) => `domain-${index.toString()}`,
        );
      },
      path: "/majors/0/minors/0/domainVocabulary",
    },
    {
      defect: "missing whole-rating anchor",
      mutate: (minor: Record<string, unknown>) => {
        const anchors = minor.ratingAnchors as Record<string, unknown>;
        delete anchors["5.0"];
      },
      path: "/majors/0/minors/0/ratingAnchors/5.0",
    },
    {
      defect: "extra half-rating anchor",
      mutate: (minor: Record<string, unknown>) => {
        const anchors = minor.ratingAnchors as Record<string, unknown>;
        anchors["2.5"] = "Half ratings belong in assessment explanations.";
      },
      path: "/majors/0/minors/0/ratingAnchors/2.5",
    },
    {
      defect: "blank whole-rating anchor",
      mutate: (minor: Record<string, unknown>) => {
        const anchors = minor.ratingAnchors as Record<string, unknown>;
        anchors["3.0"] = "   ";
      },
      path: "/majors/0/minors/0/ratingAnchors/3.0",
    },
    {
      defect: "legacy anchors field",
      mutate: (minor: Record<string, unknown>) => {
        minor.anchors = minor.ratingAnchors;
      },
      path: "/majors/0/minors/0/anchors",
    },
  ])("rejects $defect", ({ mutate, path }) => {
    const document = validScoreModelDocument();
    mutate(firstMinor(document));

    expect(
      validatePolicyDocument("score-model", document, "score-model.json"),
    ).toContainEqual(expect.objectContaining({ code: "SCHEMA_INVALID", path }));
  });

  test.each([
    {
      defect: "161-code-point vocabulary term",
      value: "x".repeat(161),
      path: "/majors/0/minors/0/domainVocabulary/0",
      apply: (minor: Record<string, unknown>, value: string) => {
        minor.domainVocabulary = [value];
      },
    },
    {
      defect: "2001-code-point anchor",
      value: `Intent and contract alignment: ${"x".repeat(1970)}`,
      path: "/majors/0/minors/0/ratingAnchors/0.0",
      apply: (minor: Record<string, unknown>, value: string) => {
        const anchors = minor.ratingAnchors as Record<string, unknown>;
        anchors["0.0"] = value;
      },
    },
  ])(
    "keeps the runtime resource limit for a $defect",
    ({ value, path, apply }) => {
      const document = validScoreModelDocument();
      apply(firstMinor(document), value);

      expect(
        validatePolicyDocument("score-model", document, "score-model.json"),
      ).toContainEqual(
        expect.objectContaining({ code: "SCHEMA_INVALID", path }),
      );
    },
  );

  test("rejects unknown document keys", () => {
    const document = validScoreModelDocument();
    document.untrustedExtension = true;

    expect(
      validatePolicyDocument("score-model", document, "score-model.json"),
    ).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_INVALID",
        path: "/untrustedExtension",
      }),
    );
  });

  test("runs bounded semantic validation after structural validation", () => {
    const document = validScoreModelDocument();
    const majors = document.majors;
    if (!Array.isArray(majors) || typeof majors[0] !== "object") {
      throw new Error("missing first major");
    }
    Reflect.set(majors[0], "weightTenths", 201);

    expect(
      validatePolicyDocument("score-model", document, "score-model.json"),
    ).toContainEqual(
      expect.objectContaining({
        code: "MAJOR_TOTAL_INVALID",
        source: "score-model.json",
        path: "/majors",
      }),
    );
  });
});
