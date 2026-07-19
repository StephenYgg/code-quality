import { describe, expect, test } from "vitest";

import { MAX_POLICY_DIAGNOSTICS_PER_RESOLUTION } from "../../../src/core/policy-diagnostics.js";
import {
  findApplicableWaivers,
  validateWaiver,
  validateWaiverInputs,
  type Waiver,
} from "../../../src/core/waivers.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function validWaiver(overrides: Partial<Waiver> = {}): Waiver {
  return {
    schemaVersion: "1",
    id: "waiver-readability-export",
    ruleId: "CQ-READ-003",
    ruleVersion: { minimum: 1, maximum: 2 },
    repository: "StephenYgg/example",
    scope: {
      paths: ["src/export/**"],
      symbols: ["exportData"],
    },
    reason: "The behavior must remain stable during a bounded migration.",
    riskAcceptance:
      "The owner accepts wider error classification until migration.",
    approver: "engineering-director",
    owner: "export-team",
    compensatingControls: [
      "Characterization tests cover every current outcome.",
    ],
    trackingIssue: "https://example.invalid/issues/123",
    createdAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("waiver validation", () => {
  test("accepts an accountable, unexpired waiver", () => {
    expect(validateWaiver(validWaiver(), NOW)).toEqual([]);
  });

  test("rejects expired waivers", () => {
    const diagnostics = validateWaiver(
      validWaiver({ expiresAt: "2026-07-19T11:59:59.000Z" }),
      NOW,
    );

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "WAIVER_EXPIRED", path: "/expiresAt" }),
    );
  });

  test.each([
    "reason",
    "riskAcceptance",
    "approver",
    "owner",
    "compensatingControls",
    "trackingIssue",
    "createdAt",
    "expiresAt",
  ] as const)("rejects missing accountability field %s", (field) => {
    const waiver = { ...validWaiver() } as Record<string, unknown>;
    Reflect.deleteProperty(waiver, field);

    const diagnostics = validateWaiver(waiver, NOW);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_INVALID", path: `/${field}` }),
    );
  });

  test("rejects an inverted rule-version range", () => {
    const diagnostics = validateWaiver(
      validWaiver({ ruleVersion: { minimum: 3, maximum: 2 } }),
      NOW,
    );

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "WAIVER_VERSION_RANGE_INVALID" }),
    );
  });

  test.each([
    "2026-02-30T00:00:00.000Z",
    "2026-02-31T00:00:00.000Z",
    "2026-04-31T00:00:00.000Z",
    "2023-02-29T00:00:00.000Z",
  ])("rejects impossible RFC3339 UTC timestamp %s", (createdAt) => {
    const diagnostics = validateWaiver(validWaiver({ createdAt }), NOW);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "WAIVER_TIMESTAMP_INVALID",
        path: "/createdAt",
      }),
    );
  });

  test("accepts a valid leap-day RFC3339 UTC timestamp", () => {
    expect(
      validateWaiver(
        validWaiver({ createdAt: "2024-02-29T00:00:00.000Z" }),
        NOW,
      ),
    ).toEqual([]);
  });

  test("rejects an invalid current time and never matches with it", () => {
    const invalidNow = new Date(Number.NaN);
    const validation = validateWaiverInputs([validWaiver()], invalidNow);

    expect(validation.values).toEqual([]);
    expect(validation.diagnostics).toContainEqual(
      expect.objectContaining({ code: "WAIVER_NOW_INVALID" }),
    );
    expect(
      findApplicableWaivers(
        [validWaiver()],
        {
          repository: "StephenYgg/example",
          ruleId: "CQ-READ-003",
          ruleVersion: 1,
          path: "src/export/runner.ts",
          symbol: "exportData",
        },
        invalidNow,
      ),
    ).toEqual([]);
  });

  test("returns validated values separately from invalid unknown inputs", () => {
    const invalid = { ...validWaiver(), unexpected: true };

    const result = validateWaiverInputs([validWaiver(), invalid], NOW);

    expect(result.values).toHaveLength(1);
    expect(result.values[0]?.id).toBe("waiver-readability-export");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_INVALID",
        source: "waivers[1]",
        path: "/unexpected",
      }),
    );
  });

  test("bounds diagnostics across many invalid waiver documents", () => {
    const values = Array.from({ length: 200 }, (_, index) =>
      validWaiver({
        id: `waiver-invalid-${String(index).padStart(3, "0")}`,
        ruleVersion: { minimum: 3, maximum: 2 },
        createdAt: "2026-02-30T00:00:00.000Z",
        expiresAt: "2026-02-31T00:00:00.000Z",
      }),
    );
    const sources = values.map(
      (_, index) => `waivers/invalid-${String(index).padStart(3, "0")}.yaml`,
    );

    const result = validateWaiverInputs(values, NOW, sources);

    expect(result.diagnostics.length).toBeLessThanOrEqual(
      MAX_POLICY_DIAGNOSTICS_PER_RESOLUTION,
    );
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === "DIAGNOSTIC_LIMIT_EXCEEDED",
      ),
    ).toHaveLength(1);
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.source.includes("invalid-199.yaml"),
      ),
    ).toBe(false);
  });
});

describe("explicit waiver applicability", () => {
  test("rejects an unbounded waiver matching request", () => {
    const waivers = Array.from({ length: 1_001 }, () => validWaiver());

    expect(() =>
      findApplicableWaivers(
        waivers,
        {
          repository: "StephenYgg/example",
          ruleId: "CQ-READ-003",
          ruleVersion: 1,
          path: "src/export/runner.ts",
          symbol: "exportData",
        },
        NOW,
      ),
    ).toThrow("at most 1000 waivers");
  });

  test("matches rule version, repository, path, and symbol scope together", () => {
    const waiver = validWaiver();

    const matches = findApplicableWaivers(
      [waiver],
      {
        repository: "StephenYgg/example",
        ruleId: "CQ-READ-003",
        ruleVersion: 2,
        path: "src/export/runner.ts",
        symbol: "exportData",
        findingId: "finding-1",
        changeId: "change-1",
      },
      NOW,
    );

    expect(matches).toEqual([waiver]);
  });

  test.each([
    ["unknown field", { ...validWaiver(), unexpected: true }],
    ["wrong schema version", { ...validWaiver(), schemaVersion: "2" }],
    [
      "missing scope",
      Object.fromEntries(
        Object.entries(validWaiver()).filter(([key]) => key !== "scope"),
      ),
    ],
    ["primitive", null],
  ])(
    "never matches or throws for schema-invalid input with %s",
    (_label, input) => {
      expect(() =>
        findApplicableWaivers(
          [input],
          {
            repository: "StephenYgg/example",
            ruleId: "CQ-READ-003",
            ruleVersion: 1,
            path: "src/export/runner.ts",
            symbol: "exportData",
          },
          NOW,
        ),
      ).not.toThrow();
      expect(
        findApplicableWaivers(
          [input],
          {
            repository: "StephenYgg/example",
            ruleId: "CQ-READ-003",
            ruleVersion: 1,
            path: "src/export/runner.ts",
            symbol: "exportData",
          },
          NOW,
        ),
      ).toEqual([]);
    },
  );

  test.each([
    ["repository", { repository: "other/repository" }],
    ["rule", { ruleId: "CQ-READ-004" }],
    ["version", { ruleVersion: 3 }],
    ["path", { path: "src/import/runner.ts" }],
    ["symbol", { symbol: "importData" }],
  ] as const)("does not match a different %s", (_label, contextOverride) => {
    const matches = findApplicableWaivers(
      [validWaiver()],
      {
        repository: "StephenYgg/example",
        ruleId: "CQ-READ-003",
        ruleVersion: 2,
        path: "src/export/runner.ts",
        symbol: "exportData",
        ...contextOverride,
      },
      NOW,
    );

    expect(matches).toEqual([]);
  });

  test("requires explicit change and finding matches when those scopes exist", () => {
    const waiver = validWaiver({
      scope: {
        changes: ["change-17"],
        findings: ["finding-9"],
      },
    });

    expect(
      findApplicableWaivers(
        [waiver],
        {
          repository: "StephenYgg/example",
          ruleId: "CQ-READ-003",
          ruleVersion: 1,
          changeId: "change-17",
          findingId: "finding-9",
        },
        NOW,
      ),
    ).toEqual([waiver]);
    expect(
      findApplicableWaivers(
        [waiver],
        {
          repository: "StephenYgg/example",
          ruleId: "CQ-READ-003",
          ruleVersion: 1,
          changeId: "change-17",
          findingId: "other-finding",
        },
        NOW,
      ),
    ).toEqual([]);
  });

  test("keeps the finding visible by returning matching waivers separately", () => {
    const finding = Object.freeze({ id: "finding-1", status: "confirmed" });

    const matches = findApplicableWaivers(
      [validWaiver({ scope: { findings: ["finding-1"] } })],
      {
        repository: "StephenYgg/example",
        ruleId: "CQ-READ-003",
        ruleVersion: 1,
        findingId: finding.id,
      },
      NOW,
    );

    expect(matches).toHaveLength(1);
    expect(finding).toEqual({ id: "finding-1", status: "confirmed" });
  });
});
