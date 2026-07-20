import { describe, expect, test } from "vitest";

import { createFinding } from "../../../src/core/findings.js";
import { toFindingDocument } from "../../../src/core/finding-document.js";
import { validateDocument } from "../../../src/core/policy-schema.js";
import { toRunDocument } from "../../../src/core/run-document.js";
import {
  DEFAULT_SCORE_MODEL,
  type Assessment,
} from "../../../src/core/scoring.js";
import { createReviewSnapshot } from "../../../src/core/snapshots.js";
import type { ReviewRunResult } from "../../../src/review/orchestrator.js";
import { scoreFromReview } from "../../../src/review/score-bridge.js";
import { sanitizeRunRecord } from "../../../src/storage/runs.js";

function sampleFinding() {
  return createFinding({
    id: "finding-1",
    ruleId: "CQ-READ-001",
    title: "Oversized function",
    severity: "P2",
    disposition: "new",
    confidence: "high",
    stages: ["readability"],
    location: { path: "src/a.ts", startLine: 10, endLine: 200 },
    evidence: "function body exceeds the line budget",
    impact: "harder to review and modify safely",
    remediation: "split the function by stage",
    trigger: "function length over threshold",
    actualBehavior: "single function owns many stages",
    expectedBehavior: "one clear responsibility per function",
    verification: "re-run readability inspect after split",
    provider: "codex",
    model: "gpt-test",
  });
}

function sampleResult(
  findings: ReturnType<typeof sampleFinding>[] = [sampleFinding()],
): ReviewRunResult {
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
    runId: "00000000-0000-4000-8000-000000000001",
    gate: "WARN",
    findings,
    corroborated: [],
    uncertain: [],
    waived: [],
    plan: {
      stages: ["readability"],
      signals: {},
      maxInFlight: 2,
      maxAttempts: 16,
      execution: "full",
    },
    snapshot,
    incomplete: false,
    providerAttempts: 1,
    promptBundleVersion: "cq-prompt-bundle/v2",
    reportHash: "b".repeat(64),
    contentBundleHash: "f".repeat(64),
    assessments: [],
    scoreGate: "WARN",
    contextIncomplete: false,
    cacheKey: "c".repeat(64),
  };
}

function scoredAssessments(): readonly Assessment[] {
  return DEFAULT_SCORE_MODEL.majors.flatMap((major) =>
    major.minors.map((minor) => ({
      minorId: minor.id,
      status: "scored" as const,
      rating: 4,
      confidence: "high" as const,
      evidence: ["src/a.ts:10-10:captured evidence"],
      explanation: "The immutable source range supports this assessment.",
    })),
  );
}

function runDocumentOptions() {
  return {
    policyHash: "d".repeat(64),
    providerName: "codex",
    providerKind: "codex_cli",
    model: "gpt-test",
    adapterVersion: "cq-provider-adapter/v1",
    startedAt: "2026-07-19T12:00:00.000Z",
    completedAt: "2026-07-19T12:00:01.000Z",
  } as const;
}

describe("finding and run documents", () => {
  test("toFindingDocument validates against finding.schema.json", () => {
    const document = toFindingDocument(sampleFinding());
    const validated = validateDocument("finding", document, "test");
    expect(validated.diagnostics).toEqual([]);
    expect(validated.value).toBeDefined();
    expect(document.ruleId).toBe("CQ-READ-001");
    expect(document.locations[0]?.path).toBe("src/a.ts");
  });

  test("toFindingDocument fills missing rule id from stage", () => {
    const finding = createFinding({
      id: "f2",
      title: "Concurrency race",
      severity: "P1",
      disposition: "unknown",
      confidence: "medium",
      stages: ["concurrency"],
      evidence: "check then act without lock",
      impact: "duplicate side effects under load",
      remediation: "acquire ownership before side effects",
    });
    const document = toFindingDocument(finding, {
      provider: "claude",
      model: "sonnet",
    });
    expect(document.ruleId).toBe("CQ-CONC-001");
    expect(document.provider).toBe("claude");
    const validated = validateDocument("finding", document, "test");
    expect(validated.diagnostics).toEqual([]);
  });

  test("toRunDocument validates against run.schema.json with reproducibility", () => {
    const result = sampleResult();
    const document = toRunDocument(result, {
      ...runDocumentOptions(),
      providerVersion: "fake-cli 1.0.0-test",
    });
    const validated = validateDocument("run", document, "test");
    expect(validated.diagnostics).toEqual([]);
    expect(document.reproducibility.adapterVersion).toBe(
      "cq-provider-adapter/v1",
    );
    expect(document.reproducibility.providerVersion).toBe(
      "fake-cli 1.0.0-test",
    );
    expect(document.findingIds).toEqual(["finding-1"]);
    expect(document.input.contentBundleHash).toBe("f".repeat(64));
    expect(document.score).toBeUndefined();

    const { contentBundleHash: _omitted, ...inputWithoutBundleHash } =
      document.input;
    expect(_omitted).toBe(document.input.contentBundleHash);
    const missing = validateDocument(
      "run",
      { ...document, input: inputWithoutBundleHash },
      "missing-content-bundle",
    );
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({ path: "/input/contentBundleHash" }),
    );

    const { reproducibility: _reproducibility, ...withoutReproducibility } =
      document;
    expect(_reproducibility).toBe(document.reproducibility);
    const missingReproducibility = validateDocument(
      "run",
      withoutReproducibility,
      "missing-reproducibility",
    );
    expect(missingReproducibility.value).toBeUndefined();
    expect(missingReproducibility.diagnostics).toContainEqual(
      expect.objectContaining({ path: "/reproducibility" }),
    );
  });

  test("toRunDocument preserves real score model metadata and totals", () => {
    const assessments = scoredAssessments();
    const base = sampleResult([]);
    const score = scoreFromReview({ ...base, assessments });
    const result: ReviewRunResult = {
      ...base,
      assessments,
      score,
      scoreGate: score.gate,
    };

    const document = toRunDocument(result, runDocumentOptions());

    expect(document.score).toEqual({
      modelId: score.model.id,
      modelVersion: score.model.version,
      normalizedTenths: Math.round(Number(score.totals.normalized) * 10),
      coverageTenths: Math.round(Number(score.totals.coverage) * 10),
    });
    expect(validateDocument("run", document, "scored-run").diagnostics).toEqual(
      [],
    );
  });

  test("toRunDocument preserves nullable N/A score totals", () => {
    const assessments: readonly Assessment[] =
      DEFAULT_SCORE_MODEL.majors.flatMap((major) =>
        major.minors.map((minor) => ({
          minorId: minor.id,
          status: "not_applicable" as const,
          reason: "This focused change does not exercise the domain.",
        })),
      );
    const base = sampleResult([]);
    const score = scoreFromReview({ ...base, assessments });
    expect(score.totals.normalized).toBeNull();
    expect(score.totals.coverage).toBeNull();
    const result: ReviewRunResult = {
      ...base,
      assessments,
      score,
      scoreGate: score.gate,
    };

    const document = toRunDocument(result, runDocumentOptions());

    expect(document.score).toEqual({
      modelId: score.model.id,
      modelVersion: score.model.version,
      normalizedTenths: null,
      coverageTenths: null,
    });
    expect(validateDocument("run", document, "n-a-score").diagnostics).toEqual(
      [],
    );
  });

  test("sanitizeRunRecord embeds schema-valid documents", () => {
    const result = sampleResult();
    const record = sanitizeRunRecord(result, {
      policyHash: "e".repeat(64),
      providerName: "codex",
      providerKind: "codex_cli",
      model: "gpt-test",
      adapterVersion: "cq-provider-adapter/v1",
      startedAt: "2026-07-19T12:00:00.000Z",
    });
    expect(record.schemaVersion).toBe("1");
    expect(record.adapterVersion).toBe("cq-provider-adapter/v1");
    expect(record.contentBundleHash).toBe(result.contentBundleHash);
    expect(record.runDocument.input.contentBundleHash).toBe(
      record.contentBundleHash,
    );
    expect(record.findingDocuments).toHaveLength(1);
    const findingValidated = validateDocument(
      "finding",
      record.findingDocuments[0],
      "stored-finding",
    );
    expect(findingValidated.diagnostics).toEqual([]);
    const runValidated = validateDocument(
      "run",
      record.runDocument,
      "stored-run",
    );
    expect(runValidated.diagnostics).toEqual([]);
  });

  test("sanitizeRunRecord preserves every finding bucket and bounded diagnostics", () => {
    const base = sampleFinding();
    const confirmed = {
      ...base,
      id: "confirmed-1",
      lifecycle: "confirmed" as const,
    };
    const corroborated = {
      ...base,
      id: "corroborated-1",
      lifecycle: "corroborated" as const,
      blockingVerificationUnresolved: true,
    };
    const uncertain = {
      ...base,
      id: "uncertain-1",
      lifecycle: "uncertain" as const,
    };
    const waived = { ...base, id: "waived-1", lifecycle: "waived" as const };
    const result: ReviewRunResult = {
      ...sampleResult([]),
      findings: [confirmed],
      corroborated: [corroborated],
      uncertain: [uncertain],
      waived: [waived],
      diagnostics: Array.from({ length: 40 }, (_, index) => ({
        code: "PROVIDER_RESPONSE_INVALID" as const,
        stageId: `stage-${String(index)}-${"s".repeat(300)}`,
        path: `/candidates/${String(index)}/${"p".repeat(600)}`,
        message: `Bearer replayable-token ${"界".repeat(600)}`,
      })),
    };

    const record = sanitizeRunRecord(result, {
      policyHash: "e".repeat(64),
      providerName: "codex",
      providerKind: "codex_cli",
      model: "gpt-test",
      adapterVersion: "cq-provider-adapter/v1",
      startedAt: "2026-07-19T12:00:00.000Z",
    });

    expect(record.findings).toEqual([confirmed]);
    expect(record.corroborated).toEqual([corroborated]);
    expect(record.uncertain).toEqual([uncertain]);
    expect(record.waived).toEqual([waived]);
    expect(record.findingIds).toEqual([
      "confirmed-1",
      "corroborated-1",
      "uncertain-1",
      "waived-1",
    ]);
    expect(record.findingDocuments.map((finding) => finding.id)).toEqual(
      record.findingIds,
    );
    expect(record.runDocument.findingIds).toEqual(record.findingIds);
    expect(record.diagnostics).toHaveLength(32);
    expect(record.diagnostics[0]?.message).toContain("[REDACTED]");
    expect(JSON.stringify(record.diagnostics)).not.toContain(
      "replayable-token",
    );
    for (const diagnostic of record.diagnostics) {
      expect(Buffer.byteLength(diagnostic.code, "utf8")).toBeLessThanOrEqual(
        120,
      );
      expect(Buffer.byteLength(diagnostic.stageId, "utf8")).toBeLessThanOrEqual(
        120,
      );
      expect(
        Buffer.byteLength(diagnostic.path ?? "", "utf8"),
      ).toBeLessThanOrEqual(256);
      expect(Buffer.byteLength(diagnostic.message, "utf8")).toBeLessThanOrEqual(
        512,
      );
    }
  });
});
