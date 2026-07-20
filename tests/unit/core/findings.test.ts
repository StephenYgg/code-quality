import { describe, expect, test } from "vitest";

import {
  createFinding,
  decideGate,
  dedupeFindings,
  type Finding,
  type FindingGate,
  type FindingLifecycle,
  type FindingSeverity,
} from "../../../src/core/findings.js";
import { buildReviewReportHash } from "../../../src/review/orchestrator.js";

interface MergeOutcome {
  readonly finding: Finding;
  readonly gate: FindingGate;
  readonly reportHash: string;
}

function finding(options: {
  readonly id: string;
  readonly lifecycle: FindingLifecycle;
  readonly severity?: FindingSeverity;
  readonly stage: string;
  readonly evidence: string;
  readonly verification: string;
  readonly blocker?: boolean;
}): Finding {
  const prefix = options.id.endsWith("a") ? "alpha" : "zebra";
  return createFinding({
    id: options.id,
    ruleId: "CQ-BEH-001",
    title:
      prefix === "alpha"
        ? "Authorization is skipped"
        : "authorization is skipped",
    severity: options.severity ?? "P1",
    lifecycle: options.lifecycle,
    disposition: prefix === "alpha" ? "new" : "unknown",
    confidence: options.lifecycle === "uncertain" ? "low" : "high",
    stages: [options.stage],
    location: { path: "src/auth.ts", startLine: 10, endLine: 12 },
    evidence: options.evidence,
    impact: `${prefix} impact 000`,
    remediation: `${prefix} repair 000`,
    trigger: `${prefix} trigger 00`,
    actualBehavior: `${prefix} actual 000`,
    expectedBehavior: `${prefix} expect 000`,
    verification: options.verification,
    ...(options.blocker === true
      ? { blockingVerificationUnresolved: true }
      : {}),
    provider: prefix,
    model: `${prefix}-model`,
    createdAt:
      prefix === "alpha"
        ? "2026-07-20T00:00:00.000Z"
        : "2026-07-20T00:00:01.000Z",
  });
}

function mergeOutcome(items: readonly Finding[]): MergeOutcome {
  const merged = dedupeFindings(items);
  const result = merged[0];
  if (result === undefined || merged.length !== 1) {
    throw new Error("Expected one merged finding");
  }
  const confirmed = merged.filter(
    (item) => item.lifecycle === "confirmed" || item.lifecycle === "reported",
  );
  const corroborated = merged.filter(
    (item) => item.lifecycle === "corroborated",
  );
  const uncertain = merged.filter((item) => item.lifecycle === "uncertain");
  const waived = merged.filter((item) => item.lifecycle === "waived");
  const incomplete = corroborated.some(
    (item) => item.blockingVerificationUnresolved === true,
  );
  const gate = decideGate({ findings: confirmed, incomplete });
  return {
    finding: result,
    gate,
    reportHash: buildReviewReportHash({
      snapshotContentHash: "1".repeat(64),
      contentBundleHash: "2".repeat(64),
      policyHash: "3".repeat(64),
      providerName: "test-provider",
      model: "test-model",
      promptBundleVersion: "cq-prompt-bundle/v2",
      gate,
      incomplete,
      findings: confirmed,
      corroborated,
      uncertain,
      waived,
      diagnostics: [],
      scoringMode: "unscored",
      scoreGate: gate,
      assessments: [],
    }),
  };
}

function expectPermutationInvariant(
  first: Finding,
  second: Finding,
  expectedLifecycle: FindingLifecycle,
  expectedGate: FindingGate,
): MergeOutcome {
  const forward = mergeOutcome([first, second]);
  const reverse = mergeOutcome([second, first]);
  expect(reverse).toEqual(forward);
  expect(forward.finding.lifecycle).toBe(expectedLifecycle);
  expect(forward.gate).toBe(expectedGate);
  expect(forward.finding.id).toBe("finding-a");
  expect(forward.finding.stages).toEqual(["behavior", "security"]);
  expect(forward.finding.evidence).toBe("alpha proof 0000");
  expect(reverse.reportHash).toBe(forward.reportHash);
  return forward;
}

describe("deterministic finding deduplication", () => {
  test("independent confirmation wins over corroboration in either order", () => {
    const confirmed = finding({
      id: "finding-z",
      lifecycle: "confirmed",
      stage: "security",
      evidence: "zebra proof 0000",
      verification: "independent verification succeeded",
    });
    const corroborated = finding({
      id: "finding-a",
      lifecycle: "corroborated",
      stage: "behavior",
      evidence: "alpha proof 0000",
      verification: "source corroboration only",
      blocker: true,
    });

    const outcome = expectPermutationInvariant(
      confirmed,
      corroborated,
      "confirmed",
      "BLOCK",
    );
    expect(outcome.finding.verification).toBe(
      "independent verification succeeded",
    );
    expect(outcome.finding.blockingVerificationUnresolved).toBeUndefined();
  });

  test("independent confirmation wins over uncertainty in either order", () => {
    const confirmed = finding({
      id: "finding-z",
      lifecycle: "confirmed",
      stage: "security",
      evidence: "zebra proof 0000",
      verification: "independent verification succeeded",
    });
    const uncertain = finding({
      id: "finding-a",
      lifecycle: "uncertain",
      stage: "behavior",
      evidence: "alpha proof 0000",
      verification: "evidence remains uncertain",
    });

    const outcome = expectPermutationInvariant(
      confirmed,
      uncertain,
      "confirmed",
      "BLOCK",
    );
    expect(outcome.finding.verification).toBe(
      "independent verification succeeded",
    );
  });

  test("waiver remains non-blocking when duplicated with confirmation", () => {
    const waived = finding({
      id: "finding-a",
      lifecycle: "waived",
      stage: "behavior",
      evidence: "alpha proof 0000",
      verification: "waiver approved with compensating control",
    });
    const confirmed = finding({
      id: "finding-z",
      lifecycle: "confirmed",
      stage: "security",
      evidence: "zebra proof 0000",
      verification: "independent verification succeeded",
    });

    const outcome = expectPermutationInvariant(
      waived,
      confirmed,
      "waived",
      "PASS",
    );
    expect(outcome.finding.verification).toBe(
      "waiver approved with compensating control",
    );
  });

  test("a real severity contradiction remains uncertain in either order", () => {
    const blocking = finding({
      id: "finding-z",
      lifecycle: "confirmed",
      severity: "P1",
      stage: "security",
      evidence: "zebra proof 0000",
      verification: "independent verification succeeded",
    });
    const warning = finding({
      id: "finding-a",
      lifecycle: "confirmed",
      severity: "P2",
      stage: "behavior",
      evidence: "alpha proof 0000",
      verification: "independent verification also succeeded",
    });

    const outcome = expectPermutationInvariant(
      blocking,
      warning,
      "uncertain",
      "PASS",
    );
    expect(outcome.finding.severity).toBe("P1");
    expect(outcome.finding.verification).toMatch(/conflict/iu);
  });
});
