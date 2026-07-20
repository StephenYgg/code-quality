import { describe, expect, test } from "vitest";

import {
  STAGE_OUTPUT_SCHEMA,
  validateStageOutput,
} from "../../../src/review/stage-output.js";

function validCandidate() {
  return {
    title: "Authorization is skipped",
    severity: "P1",
    evidence: "The resource load is not guarded by an ownership check.",
    path: "src/auth.ts",
    startLine: 2,
    endLine: 2,
    sourceQuote: "return loadResource(id);",
    impact: "A caller can load another tenant's resource.",
    remediation: "Check ownership before loading the resource.",
  };
}

function validAssessment() {
  return {
    minorId: "authentication-authorization-tenant-isolation",
    status: "scored",
    rating: 4.5,
    confidence: "high",
    evidence: [
      {
        path: "src/auth.ts",
        startLine: 2,
        endLine: 2,
        sourceQuote: "return loadResource(id);",
      },
    ],
    explanation: "The captured line shows the resource access boundary.",
  };
}

describe("stage output validation", () => {
  test.each([
    ["missing candidates", {}],
    [
      "unknown severity",
      {
        candidates: [{ ...validCandidate(), severity: "CRITICAL" }],
      },
    ],
    [
      "unknown candidate key",
      {
        candidates: [{ ...validCandidate(), invented: true }],
      },
    ],
    [
      "missing range",
      {
        candidates: [
          {
            ...validCandidate(),
            startLine: undefined,
            endLine: undefined,
          },
        ],
      },
    ],
    [
      "missing quote or contract fact",
      {
        candidates: [
          {
            ...validCandidate(),
            sourceQuote: undefined,
          },
        ],
      },
    ],
    [
      "unbounded line number",
      {
        candidates: [
          {
            ...validCandidate(),
            endLine: 10_000_001,
          },
        ],
      },
    ],
  ])("rejects %s with a structured diagnostic", (_label, content) => {
    const result = validateStageOutput("security", content);

    expect(result).toMatchObject({
      ok: false,
      diagnostic: {
        code: "PROVIDER_RESPONSE_INVALID",
        stageId: "security",
      },
    });
  });

  test("accepts and freezes bounded evidence output", () => {
    const result = validateStageOutput("security", {
      candidates: [validCandidate()],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.candidates).toHaveLength(1);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.candidates[0])).toBe(true);
    }
    expect(STAGE_OUTPUT_SCHEMA.properties.candidates.maxItems).toBeGreaterThan(
      0,
    );
  });

  test("allows ordinary review output to omit assessments", () => {
    const result = validateStageOutput("security", {
      candidates: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.assessments).toBeUndefined();
  });

  test("accepts and deeply freezes explicit scored and not-applicable assessments", () => {
    const result = validateStageOutput("security", {
      candidates: [],
      assessments: [
        validAssessment(),
        {
          minorId: "secrets-privacy-logging-retention-deletion",
          status: "not_applicable",
          reason: "The captured change does not handle secrets or user data.",
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.assessments).toHaveLength(2);
      expect(Object.isFrozen(result.value.assessments)).toBe(true);
      expect(Object.isFrozen(result.value.assessments?.[0])).toBe(true);
      const assessment = result.value.assessments?.[0];
      if (assessment?.status === "scored") {
        expect(Object.isFrozen(assessment.evidence)).toBe(true);
        expect(Object.isFrozen(assessment.evidence[0])).toBe(true);
      }
    }
  });

  test.each([
    [
      "model-created not_assessed",
      { ...validAssessment(), status: "not_assessed" },
    ],
    ["rating outside half steps", { ...validAssessment(), rating: 4.2 }],
    [
      "scored assessment without evidence",
      { ...validAssessment(), evidence: [] },
    ],
    [
      "scored assessment with a whitespace explanation",
      { ...validAssessment(), explanation: "  \n\t" },
    ],
    [
      "not-applicable assessment with a whitespace reason",
      {
        minorId: "secrets-privacy-logging-retention-deletion",
        status: "not_applicable",
        reason: "   \n\t",
      },
    ],
    [
      "unbounded evidence range",
      {
        ...validAssessment(),
        evidence: [
          {
            ...validAssessment().evidence[0],
            endLine: 10_000_001,
          },
        ],
      },
    ],
  ])("rejects %s in assessments", (_label, assessment) => {
    const result = validateStageOutput("security", {
      candidates: [],
      assessments: [assessment],
    });

    expect(result.ok).toBe(false);
  });
});
