import { describe, expect, test } from "vitest";

import { createReviewSnapshot } from "../../../src/core/snapshots.js";
import type {
  ProviderDiagnostic,
  ProviderReviewRequest,
  ProviderReviewResponse,
  ReviewProvider,
} from "../../../src/providers/provider.js";
import { planReview } from "../../../src/review/planner.js";
import { runReview } from "../../../src/review/orchestrator.js";
import {
  createFinding,
  decideGate,
  transitionFinding,
} from "../../../src/core/findings.js";

class FakeProvider implements ReviewProvider {
  constructor(private readonly payload: unknown) {}
  capabilities() {
    return {
      kind: "codex_cli" as const,
      transport: "process" as const,
      structuredOutput: "prompt_json" as const,
      isolation: "no_tools" as const,
      usage: "unavailable" as const,
      finishReason: "derived" as const,
      requestId: "execution_id" as const,
      cancellation: true as const,
    };
  }
  validateConfiguration(): Promise<readonly ProviderDiagnostic[]> {
    return Promise.resolve([]);
  }
  review(request: ProviderReviewRequest): Promise<ProviderReviewResponse> {
    void request;
    return Promise.resolve({
      content: this.payload,
      usage: null,
      finishReason: "stop",
      rawFinishReason: null,
      providerRequestId: "fake",
      truncated: false,
      attemptsUsed: 1,
    });
  }
  redactDiagnostic(value: unknown): string {
    return String(value);
  }
}

describe("review orchestration", () => {
  test("keeps mandatory stages and verifies candidates", async () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [
        {
          path: "src/auth.ts",
          status: "modified",
          binary: false,
        },
      ],
      exclusions: [],
      incomplete: false,
      diff: "diff --git a/src/auth.ts b/src/auth.ts\n",
    });
    const plan = planReview(snapshot);
    expect(plan.stages).toEqual(
      expect.arrayContaining([
        "universal",
        "behavior",
        "readability",
        "testing",
        "concurrency",
      ]),
    );
    expect(plan.stages.length).toBeLessThanOrEqual(7);

    const result = await runReview({
      provider: new FakeProvider({
        candidates: [
          {
            title: "Auth check missing",
            severity: "P1",
            evidence: "no authorization around resource load",
            path: "src/auth.ts",
            impact: "access control gap",
            remediation: "verify tenant ownership",
          },
        ],
      }),
      snapshot,
    });
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.gate).toBe("BLOCK");
  });

  test("finding transitions reject illegal moves", () => {
    const finding = createFinding({
      id: "1",
      title: "x",
      severity: "P3",
      disposition: "new",
      confidence: "low",
      stages: ["behavior"],
      evidence: "evidence",
      impact: "impact",
      remediation: "fix",
    });
    expect(() => transitionFinding(finding, "reported")).toThrow(/Illegal/);
    expect(decideGate({ findings: [], incomplete: true })).toBe("INCOMPLETE");
  });
});
