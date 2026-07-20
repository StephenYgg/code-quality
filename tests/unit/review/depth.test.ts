import { describe, expect, test } from "vitest";

import { assertEgressAllowed, EgressError } from "../../../src/core/egress.js";
import { createReviewSnapshot } from "../../../src/core/snapshots.js";
import { collectReviewContext } from "../../../src/review/context.js";
import { assessmentsFromReview } from "../../../src/review/score-bridge.js";
import {
  buildReviewCacheKey,
  runWithSingleFlight,
} from "../../../src/review/single-flight.js";
import { planReview } from "../../../src/review/planner.js";
import { buildStagePrompt } from "../../../src/review/prompts.js";
import { verifyCandidates } from "../../../src/review/verifier.js";
import type { ReviewRunResult } from "../../../src/review/orchestrator.js";
import { sanitizeRunRecord } from "../../../src/storage/runs.js";

describe("review depth upgrades", () => {
  test("egress gate blocks confidential content over https", () => {
    expect(() => {
      assertEgressAllowed("confidential", "https", "openai_compatible");
    }).toThrow(EgressError);
    expect(() => {
      assertEgressAllowed("confidential", "local", "codex_cli");
    }).not.toThrow();
  });

  test("blocking candidates need quoted evidence and an independent verifier", () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/auth.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: [
        "diff --git a/src/auth.ts b/src/auth.ts",
        "--- a/src/auth.ts",
        "+++ b/src/auth.ts",
        "@@ -1 +1 @@",
        "+return loadResource(id);",
      ].join("\n"),
    });
    const weak = verifyCandidates(
      "security",
      [
        {
          title: "auth bug",
          severity: "P1",
          evidence: "something looks wrong",
          path: "src/auth.ts",
        },
      ],
      snapshot,
    );
    expect(weak[0]?.lifecycle).toBe("uncertain");

    const strong = verifyCandidates(
      "security",
      [
        {
          title: "auth bug",
          severity: "P1",
          evidence: "src/auth.ts skips owner checks on delete",
          path: "src/auth.ts",
          startLine: 1,
          endLine: 1,
          sourceQuote: "return loadResource(id);",
        },
      ],
      snapshot,
      undefined,
      {
        blockingEvidenceVerifier: {
          verify: () => ({
            kind: "deterministic",
            statement: "Control-flow analysis found no ownership guard",
            path: "src/auth.ts",
            startLine: 1,
            endLine: 1,
          }),
        },
      },
    );
    expect(strong[0]?.lifecycle).toBe("confirmed");
  });

  test("context collection reads provided content map with bounds", async () => {
    const snapshot = createReviewSnapshot({
      inputKind: "repository",
      scope: "repository",
      repository: "/tmp/repo",
      head: "b".repeat(64),
      files: [
        { path: "a.ts", status: "modified", binary: false },
        { path: "b.ts", status: "modified", binary: false },
      ],
      exclusions: [],
      incomplete: false,
    });
    const context = await collectReviewContext(snapshot, {
      contentByPath: new Map([
        ["a.ts", Buffer.from("export const a = 1;\n")],
        ["b.ts", Buffer.from("export const b = 2;\n")],
      ]),
      maxFiles: 1,
    });
    expect(context.files).toHaveLength(1);
    expect(context.incomplete).toBe(true);
  });

  test("score bridge marks required minors not_assessed when incomplete", () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "c".repeat(64),
      files: [],
      exclusions: [],
      incomplete: true,
    });
    const result = {
      runId: "1",
      gate: "INCOMPLETE",
      findings: [],
      corroborated: [],
      uncertain: [],
      waived: [],
      plan: {
        stages: ["universal"],
        signals: {},
        maxInFlight: 2,
        maxAttempts: 16,
        execution: "full",
      },
      snapshot,
      incomplete: true,
      providerAttempts: 0,
      promptBundleVersion: "v",
      reportHash: "d".repeat(64),
      contentBundleHash: "d".repeat(64),
      assessments: [],
      scoreGate: "INCOMPLETE",
      contextIncomplete: true,
    } as ReviewRunResult;
    const assessments = assessmentsFromReview(result);
    expect(assessments.every((item) => item.status === "not_assessed")).toBe(
      true,
    );
    expect(assessments.length).toBeGreaterThan(10);
  });

  test("fast plan uses one general-risk stage with one repair budget", () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "d".repeat(64),
      files: [
        { path: "src/auth/session.ts", status: "modified", binary: false },
      ],
      exclusions: [],
      incomplete: false,
    });
    const fast = planReview(snapshot, { execution: "fast" });
    const full = planReview(snapshot, { execution: "full" });
    expect(fast.execution).toBe("fast");
    expect(fast.maxInFlight).toBe(1);
    expect(fast.maxAttempts).toBe(2);
    expect(fast.stages).toEqual(["universal"]);
    expect(fast.stages.length).toBeLessThanOrEqual(full.stages.length);
    expect(full.stages.length).toBeGreaterThanOrEqual(fast.stages.length);

    const instructions = buildStagePrompt(
      fast.stages[0] ?? "universal",
      snapshot,
    ).systemInstructions;
    for (const requiredFocus of [
      "behavior",
      "readability",
      "testing",
      "concurrency",
      "resource",
    ]) {
      expect(instructions).toContain(requiredFocus);
    }
  });

  test("single-flight reuses cached results for the same key", async () => {
    const nonce = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const key = buildReviewCacheKey({
      repositoryIdentity: `/tmp/repo-${nonce}`,
      contentHash: "e".repeat(64),
      contentBundleHash: "d".repeat(64),
      providerName: `fake-${nonce}`,
      model: "m",
      policyHash: "f".repeat(64),
    });
    let runs = 0;
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: `/tmp/repo-${nonce}`,
      head: "1".repeat(64),
      files: [],
      exclusions: [],
      incomplete: false,
    });
    const makeResult = (): ReviewRunResult => ({
      runId: `run-${String(runs)}`,
      gate: "PASS",
      findings: [],
      corroborated: [],
      uncertain: [],
      waived: [],
      plan: {
        stages: ["universal"],
        signals: {},
        maxInFlight: 2,
        maxAttempts: 16,
        execution: "full",
      },
      snapshot,
      incomplete: false,
      providerAttempts: 1,
      promptBundleVersion: "v2",
      reportHash: "2".repeat(64),
      contentBundleHash: "d".repeat(64),
      assessments: [],
      scoreGate: "PASS",
      contextIncomplete: false,
    });
    const env = {
      CQ_STATE_DIR: `/tmp/cq-sf-${nonce}`,
      CQ_CACHE_DIR: `/tmp/cq-sf-cache-${nonce}`,
    };

    const storage = {
      policyHash: "f".repeat(64),
      providerName: `fake-${nonce}`,
      providerKind: "codex_cli",
      model: "m",
      adapterVersion: "cq-provider-adapter/v1",
    } as const;
    const first = await runWithSingleFlight({
      key,
      contentBundleHash: "d".repeat(64),
      env,
      run: () => {
        runs += 1;
        return Promise.resolve(makeResult());
      },
      toRecord: (result) => sanitizeRunRecord(result, storage),
    });
    expect(first.kind).toBe("executed");
    const second = await runWithSingleFlight({
      key,
      contentBundleHash: "d".repeat(64),
      env,
      run: () => {
        runs += 1;
        return Promise.resolve(makeResult());
      },
      toRecord: (result) => sanitizeRunRecord(result, storage),
    });
    expect(second.kind).toBe("cached");
    expect(runs).toBe(1);
  });
});
