import { describe, expect, test } from "vitest";

import { createReviewSnapshot } from "../../../src/core/snapshots.js";
import type {
  ProviderDiagnostic,
  ProviderReviewRequest,
  ProviderReviewResponse,
  ReviewProvider,
} from "../../../src/providers/provider.js";
import { ProviderError } from "../../../src/providers/provider.js";
import { planReview } from "../../../src/review/planner.js";
import {
  buildReviewReportHash,
  runReview,
} from "../../../src/review/orchestrator.js";
import {
  createFinding,
  decideGate,
  transitionFinding,
} from "../../../src/core/findings.js";
import { DEFAULT_SCORE_MODEL } from "../../../src/core/scoring.js";

function allowedMinorIds(request: ProviderReviewRequest): readonly string[] {
  return [
    ...request.systemInstructions.matchAll(/^Allowed minor: ([^ ]+) \|/gmu),
  ].map((match) => {
    const minorId = match[1];
    if (minorId === undefined) throw new Error("allowed minor capture missing");
    return minorId;
  });
}

function scoredPayload(
  request: ProviderReviewRequest,
  invalidMinorId?: string,
  source: {
    readonly path: string;
    readonly quote: string;
  } = { path: "src/value.ts", quote: "export const value = 1;" },
): unknown {
  return {
    candidates: [],
    assessments: allowedMinorIds(request).map((minorId) => ({
      minorId,
      status: "scored",
      rating: 5,
      confidence: "high",
      evidence: [
        {
          path: source.path,
          startLine: 1,
          endLine: 1,
          sourceQuote:
            minorId === invalidMinorId
              ? `${source.quote} invalid`
              : source.quote,
        },
      ],
      explanation: "The rating is grounded in the captured source range.",
    })),
  };
}

function whitespaceNotApplicablePayload(
  request: ProviderReviewRequest,
): unknown {
  const minorIds = allowedMinorIds(request);
  return {
    candidates: [],
    assessments: minorIds.map((minorId, index) =>
      index === 0
        ? {
            minorId,
            status: "not_applicable",
            reason: " \n\t ",
          }
        : {
            minorId,
            status: "scored",
            rating: 5,
            confidence: "high",
            evidence: [
              {
                path: "src/value.ts",
                startLine: 1,
                endLine: 1,
                sourceQuote: "export const value = 1;",
              },
            ],
            explanation: "The rating is grounded in captured source.",
          },
    ),
  };
}

function whitespaceExplanationPayload(request: ProviderReviewRequest): unknown {
  return {
    candidates: [],
    assessments: allowedMinorIds(request).map((minorId, index) => ({
      minorId,
      status: "scored",
      rating: 5,
      confidence: "high",
      evidence: [
        {
          path: "src/value.ts",
          startLine: 1,
          endLine: 1,
          sourceQuote: "export const value = 1;",
        },
      ],
      explanation:
        index === 0 ? " \n\t " : "The rating is grounded in captured source.",
    })),
  };
}

type FakePayloadFactory = (
  request: ProviderReviewRequest,
  index: number,
) => unknown;

function isPayloadFactory(value: unknown): value is FakePayloadFactory {
  return typeof value === "function";
}

function responseParts(selected: unknown): {
  readonly content: unknown;
  readonly attemptsUsed: 1 | 2;
} {
  if (selected === null || typeof selected !== "object") {
    return { content: selected, attemptsUsed: 1 };
  }
  const record = selected as Record<string, unknown>;
  if (
    "content" in record &&
    (record.attemptsUsed === 1 || record.attemptsUsed === 2)
  ) {
    return { content: record.content, attemptsUsed: record.attemptsUsed };
  }
  return { content: selected, attemptsUsed: 1 };
}

class FakeProvider implements ReviewProvider {
  readonly requests: ProviderReviewRequest[] = [];

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
    const index = this.requests.length;
    this.requests.push(request);
    const selected: unknown = isPayloadFactory(this.payload)
      ? this.payload(request, index)
      : this.payload;
    const wrapped = responseParts(selected);
    return Promise.resolve({
      content: wrapped.content,
      usage: null,
      finishReason: "stop",
      rawFinishReason: null,
      providerRequestId: "fake",
      truncated: false,
      attemptsUsed: wrapped.attemptsUsed,
    });
  }
  redactDiagnostic(value: unknown): string {
    return String(value);
  }
}

class InvalidAttemptProvider extends FakeProvider {
  constructor() {
    super(null);
  }

  override review(
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse> {
    this.requests.push(request);
    return Promise.resolve({
      content: { candidates: [] },
      usage: null,
      finishReason: "stop",
      rawFinishReason: null,
      providerRequestId: "invalid-attempt-provider",
      truncated: false,
      attemptsUsed: 0 as 1,
    });
  }
}

class CancellingProvider extends FakeProvider {
  readonly started: Promise<void>;
  private markStarted: (() => void) | undefined;

  constructor() {
    super(null);
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  override review(
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse> {
    this.requests.push(request);
    this.markStarted?.();
    return new Promise((_resolve, reject) => {
      const abort = () => {
        reject(new ProviderError("PROVIDER_ABORTED", "cancelled by test"));
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

class SessionProvider extends FakeProvider {
  opened = 0;
  released = 0;
  private active = false;

  openReviewSession(): Promise<{ readonly release: () => Promise<void> }> {
    this.opened += 1;
    this.active = true;
    let released = false;
    return Promise.resolve({
      release: () => {
        if (released) return Promise.resolve();
        released = true;
        this.active = false;
        this.released += 1;
        return Promise.resolve();
      },
    });
  }

  override review(
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse> {
    if (!this.active) {
      return Promise.reject(
        new ProviderError("PROVIDER_UNSAFE", "review session is not active"),
      );
    }
    return super.review(request);
  }
}

describe("review orchestration", () => {
  test("opens one provider session for all stages and releases it", async () => {
    const provider = new SessionProvider({ candidates: [] });
    const result = await runReview({
      provider,
      snapshot: createReviewSnapshot({
        inputKind: "staged",
        scope: "change",
        repository: "/tmp/repo",
        head: "a".repeat(64),
        files: [],
        exclusions: [],
        incomplete: false,
      }),
      contentBundleHash: "b".repeat(64),
      execution: "fast",
    });

    expect(result.incomplete).toBe(false);
    expect(provider.requests).toHaveLength(1);
    expect(provider.opened).toBe(1);
    expect(provider.released).toBe(1);
  });

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
      diff: [
        "diff --git a/src/auth.ts b/src/auth.ts",
        "--- a/src/auth.ts",
        "+++ b/src/auth.ts",
        "@@ -1 +1 @@",
        "+return loadResource(id);",
      ].join("\n"),
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

    const providerPayload = {
      candidates: [
        {
          title: "Auth check missing",
          severity: "P1",
          evidence: "src/auth.ts has no authorization around resource load",
          path: "src/auth.ts",
          startLine: 1,
          endLine: 1,
          sourceQuote: "return loadResource(id);",
          impact: "access control gap",
          remediation: "verify tenant ownership",
        },
      ],
    };
    const result = await runReview({
      provider: new FakeProvider(providerPayload),
      snapshot,
      contentBundleHash: "b".repeat(64),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.corroborated.length).toBeGreaterThan(0);
    expect(result.uncertain).toHaveLength(0);
    expect(
      result.corroborated.every(
        (finding) => finding.blockingVerificationUnresolved === true,
      ),
    ).toBe(true);
    expect(result.gate).toBe("INCOMPLETE");
    expect(result.incomplete).toBe(true);
    expect(result.contentBundleHash).toBe("b".repeat(64));

    const verified = await runReview({
      provider: new FakeProvider(providerPayload),
      snapshot,
      contentBundleHash: "b".repeat(64),
      blockingEvidenceVerifier: {
        verify: () => ({
          kind: "deterministic" as const,
          statement: "Control-flow analysis found no authorization guard",
          path: "src/auth.ts",
          startLine: 1,
          endLine: 1,
        }),
      },
    });
    expect(verified.findings.length).toBeGreaterThan(0);
    expect(verified.gate).toBe("BLOCK");
  });

  test.each([
    ["missing candidates", {}],
    [
      "unknown severity",
      {
        candidates: [
          {
            title: "Invalid severity",
            severity: "CRITICAL",
            evidence: "The candidate has an unsupported severity value.",
            path: "src/value.ts",
            startLine: 1,
            endLine: 1,
            sourceQuote: "value",
          },
        ],
      },
    ],
    [
      "unknown key",
      {
        candidates: [
          {
            title: "Unknown key",
            severity: "P2",
            evidence: "The candidate includes a field outside the contract.",
            path: "src/value.ts",
            startLine: 1,
            endLine: 1,
            sourceQuote: "value",
            invented: true,
          },
        ],
      },
    ],
    [
      "missing range",
      {
        candidates: [
          {
            title: "Missing range",
            severity: "P2",
            evidence: "The candidate does not identify a bounded line range.",
            path: "src/value.ts",
            sourceQuote: "value",
          },
        ],
      },
    ],
    [
      "missing quote",
      {
        candidates: [
          {
            title: "Missing quote",
            severity: "P2",
            evidence: "The candidate does not quote source or a contract fact.",
            path: "src/value.ts",
            startLine: 1,
            endLine: 1,
          },
        ],
      },
    ],
  ])(
    "invalid stage output (%s) cannot become an empty PASS",
    async (_label, payload) => {
      const snapshot = createReviewSnapshot({
        inputKind: "staged",
        scope: "change",
        repository: "/tmp/repo",
        head: "a".repeat(64),
        files: [{ path: "src/value.ts", status: "modified", binary: false }],
        exclusions: [],
        incomplete: false,
        diff: "",
      });

      const result = await runReview({
        provider: new FakeProvider(payload),
        snapshot,
        contentBundleHash: "b".repeat(64),
        computeScore: false,
        execution: "fast",
      });

      expect(result.gate).toBe("INCOMPLETE");
      expect(result.incomplete).toBe(true);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }),
        ]),
      );
    },
  );

  test("allows one orchestrator repair within the reserved stage budget", async () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/value.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: "",
    });
    const provider = new FakeProvider(
      (_request: ProviderReviewRequest, index: number) =>
        index === 0 ? {} : { candidates: [] },
    );

    const result = await runReview({
      provider,
      snapshot,
      contentBundleHash: "b".repeat(64),
      computeScore: false,
      execution: "fast",
    });

    expect(
      provider.requests.slice(0, 2).map((request) => request.stageId),
    ).toEqual(["universal", "universal"]);
    expect(
      provider.requests
        .slice(0, 2)
        .map((request) => request.attemptBudget.maxAttempts),
    ).toEqual([2, 1]);
    expect(result.providerAttempts).toBe(2);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PROVIDER_RESPONSE_INVALID",
          stageId: "universal",
        }),
      ]),
    );
  });

  test("reserves the global attempt budget before each stage call", async () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/value.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: "",
    });
    const desiredAttempts = [2, 2, 1, 2] as const;
    const provider = new FakeProvider(
      (request: ProviderReviewRequest, index: number) => ({
        content: { candidates: [] },
        attemptsUsed: Math.min(
          desiredAttempts[index] ?? 1,
          request.attemptBudget.maxAttempts,
        ) as 1 | 2,
      }),
    );

    const result = await runReview({
      provider,
      snapshot,
      contentBundleHash: "b".repeat(64),
      computeScore: false,
      execution: "full",
      maxAttempts: 6,
    });

    expect(
      provider.requests.map((request) => request.attemptBudget.maxAttempts),
    ).toEqual([2, 2, 2, 1]);
    expect(result.providerAttempts).toBeLessThanOrEqual(
      result.plan.maxAttempts,
    );
    expect(result.providerAttempts).toBe(6);
    expect(result.gate).toBe("INCOMPLETE");
  });

  test("rejects an adapter attempt count outside its runtime contract", async () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/value.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: "",
    });
    const provider = new InvalidAttemptProvider();

    const result = await runReview({
      provider,
      snapshot,
      contentBundleHash: "b".repeat(64),
      computeScore: false,
      execution: "fast",
    });

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }),
      ]),
    );
    expect(result.providerAttempts).toBeLessThanOrEqual(
      result.plan.maxAttempts,
    );
    expect(provider.requests.length).toBeLessThanOrEqual(
      result.plan.maxAttempts,
    );
  });

  test("bounds reservations and records diagnostics when the provider throws", async () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/value.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: "",
    });
    const provider = new FakeProvider(() => {
      throw new ProviderError("PROVIDER_TIMEOUT", "provider timed out");
    });

    const result = await runReview({
      provider,
      snapshot,
      contentBundleHash: "b".repeat(64),
      computeScore: false,
      execution: "fast",
    });

    expect(result.providerAttempts).toBeLessThanOrEqual(
      result.plan.maxAttempts,
    );
    expect(provider.requests.length).toBeLessThanOrEqual(
      result.plan.maxAttempts,
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PROVIDER_TIMEOUT" }),
      ]),
    );
  });

  test("cancellation settles active reservations without hanging", async () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/value.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: "",
    });
    const provider = new CancellingProvider();
    const controller = new AbortController();
    const review = runReview({
      provider,
      snapshot,
      contentBundleHash: "b".repeat(64),
      computeScore: false,
      signal: controller.signal,
    });
    await provider.started;
    controller.abort();

    const result = await review;

    expect(result.providerAttempts).toBeLessThanOrEqual(
      result.plan.maxAttempts,
    );
    expect(provider.requests.length).toBeLessThanOrEqual(
      result.plan.maxInFlight,
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PROVIDER_ABORTED" }),
      ]),
    );
  });

  test("ordinary review does not create assessment or score documents", async () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/value.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: "",
    });

    const result = await runReview({
      provider: new FakeProvider({ candidates: [] }),
      snapshot,
      contentBundleHash: "b".repeat(64),
      execution: "fast",
    });

    expect(result.assessments).toEqual([]);
    expect(result.gate).toBe("PASS");
    expect(result.incomplete).toBe(false);
    expect(result.score).toBeUndefined();
  });

  test("fast score mode keeps unrouted security minors out of provider prompts", async () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/value.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: [
        "diff --git a/src/value.ts b/src/value.ts",
        "--- a/src/value.ts",
        "+++ b/src/value.ts",
        "@@ -1 +1 @@",
        "+export const value = 1;",
      ].join("\n"),
    });
    const provider = new FakeProvider((request: ProviderReviewRequest) =>
      scoredPayload(request),
    );

    const result = await runReview({
      provider,
      snapshot,
      context: {
        files: [
          {
            path: "src/value.ts",
            content: "export const value = 1;\n",
            byteLength: 24,
            truncated: false,
          },
        ],
        totalBytes: 24,
        incomplete: false,
        exclusions: [],
      },
      contentBundleHash: "b".repeat(64),
      computeScore: true,
      execution: "fast",
    });

    const expectedCount = DEFAULT_SCORE_MODEL.majors.flatMap(
      (major) => major.minors,
    ).length;
    const securityIds =
      DEFAULT_SCORE_MODEL.majors
        .find((major) => major.id === "security")
        ?.minors.map((minor) => minor.id) ?? [];
    const promptedIds = provider.requests.flatMap(allowedMinorIds);
    expect(promptedIds).toHaveLength(expectedCount - securityIds.length);
    expect(new Set(promptedIds).size).toBe(expectedCount - securityIds.length);
    expect(promptedIds).not.toEqual(expect.arrayContaining(securityIds));
    expect(
      provider.requests.every((request) => request.maxOutputTokens >= 8_000),
    ).toBe(true);
    expect(result.assessments).toHaveLength(expectedCount);
    expect(
      result.assessments.filter(
        (assessment) => assessment.status === "not_assessed",
      ),
    ).toHaveLength(securityIds.length);
    expect(result.score?.display.coverage).toBe("88.0");
    expect(result.score?.display.normalized).toBe("N/A");
    expect(result.scoreGate).toBe("INCOMPLETE");
  });

  test("full auth score mode gives the security stage exact unique ownership", async () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/auth.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: "",
    });
    const provider = new FakeProvider((request: ProviderReviewRequest) =>
      scoredPayload(request, undefined, {
        path: "src/auth.ts",
        quote: "export const authorized = true;",
      }),
    );

    const result = await runReview({
      provider,
      snapshot,
      context: {
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
      },
      contentBundleHash: "b".repeat(64),
      computeScore: true,
      execution: "full",
    });

    const securityIds =
      DEFAULT_SCORE_MODEL.majors
        .find((major) => major.id === "security")
        ?.minors.map((minor) => minor.id) ?? [];
    expect(result.plan.stages).toEqual(
      expect.arrayContaining(["security", "permissions"]),
    );
    for (const request of provider.requests) {
      const ownedSecurity = allowedMinorIds(request).filter((minorId) =>
        securityIds.includes(minorId),
      );
      expect(ownedSecurity).toHaveLength(
        request.stageId === "security" ? securityIds.length : 0,
      );
    }
    expect(result.assessments).toHaveLength(37);
    expect(result.score?.display.coverage).toBe("100.0");
    expect(result.score?.display.normalized).toBe("100.0");
    expect(result.scoreGate).toBe("PASS");
  });

  test("invalid immutable quote makes only its owned minor not_assessed", async () => {
    const snapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/auth.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: "",
    });
    const invalidMinor = "intent-contract";

    const result = await runReview({
      provider: new FakeProvider((request: ProviderReviewRequest) =>
        scoredPayload(request, invalidMinor, {
          path: "src/auth.ts",
          quote: "export const authorized = true;",
        }),
      ),
      snapshot,
      context: {
        files: [
          {
            path: "src/auth.ts",
            content: "export const authorized = true;\n",
            byteLength: 32,
            truncated: false,
          },
        ],
        totalBytes: 24,
        incomplete: false,
        exclusions: [],
      },
      contentBundleHash: "b".repeat(64),
      computeScore: true,
      execution: "full",
    });

    expect(result.gate).toBe("PASS");
    expect(result.incomplete).toBe(false);
    expect(result.scoreGate).toBe("INCOMPLETE");
    expect(result.assessments).toContainEqual(
      expect.objectContaining({
        minorId: invalidMinor,
        status: "not_assessed",
      }),
    );
    expect(
      result.assessments.filter(
        (assessment) => assessment.status === "not_assessed",
      ),
    ).toHaveLength(1);
  });

  test.each([
    ["not-applicable reason", whitespaceNotApplicablePayload],
    ["scored explanation", whitespaceExplanationPayload],
  ])(
    "whitespace %s consumes the bounded repair attempt",
    async (_label, invalidPayload) => {
      const snapshot = createReviewSnapshot({
        inputKind: "staged",
        scope: "change",
        repository: "/tmp/repo",
        head: "a".repeat(64),
        files: [{ path: "src/value.ts", status: "modified", binary: false }],
        exclusions: [],
        incomplete: false,
        diff: "",
      });
      const provider = new FakeProvider(
        (request: ProviderReviewRequest, index: number) =>
          index === 0 ? invalidPayload(request) : scoredPayload(request),
      );

      const result = await runReview({
        provider,
        snapshot,
        context: {
          files: [
            {
              path: "src/value.ts",
              content: "export const value = 1;\n",
              byteLength: 24,
              truncated: false,
            },
          ],
          totalBytes: 24,
          incomplete: false,
          exclusions: [],
        },
        contentBundleHash: "b".repeat(64),
        computeScore: true,
        execution: "fast",
      });

      expect(provider.requests.slice(0, 2).map((item) => item.stageId)).toEqual(
        ["universal", "universal"],
      );
      expect(result.providerAttempts).toBe(result.plan.maxAttempts);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }),
        ]),
      );
      expect(result.gate).toBe("PASS");
      expect(result.scoreGate).toBe("INCOMPLETE");
    },
  );

  test("binds the captured content bundle into report identity", () => {
    const common = reportHashInput({
      runId: "run-id",
      snapshotContentHash: "c".repeat(64),
      policyHash: "p".repeat(64),
      providerName: "provider-a",
      model: "model-a",
      promptBundleVersion: "cq-prompt-bundle/v2",
    });

    const first = buildReviewReportHash({
      ...common,
      contentBundleHash: "d".repeat(64),
    });
    const second = buildReviewReportHash({
      ...common,
      contentBundleHash: "e".repeat(64),
    });

    expect(first).not.toBe(second);
  });

  test("builds the same report hash across run ids, clocks, and finding order", () => {
    const stableFinding = (id: string, createdAt: string, title: string) =>
      createFinding({
        id,
        createdAt,
        title,
        severity: "P2",
        disposition: "new",
        confidence: "high",
        stages: ["testing", "behavior"],
        location: { path: "src/value.ts", startLine: 2, endLine: 2 },
        evidence: "The added branch has no observable behavior test.",
        impact: "A regression can pass without detection.",
        remediation: "Add a behavior-level regression test.",
        lifecycle: "confirmed",
      });
    const firstFinding = stableFinding(
      "runtime-id-1",
      "2026-01-01T00:00:00.000Z",
      "Missing branch test",
    );
    const secondFinding = stableFinding(
      "runtime-id-2",
      "2030-01-01T00:00:00.000Z",
      "Missing error test",
    );
    const common = reportHashInput({
      snapshotContentHash: "a".repeat(64),
      contentBundleHash: "b".repeat(64),
      policyHash: "c".repeat(64),
      providerName: "provider-a",
      model: "model-a",
      promptBundleVersion: "cq-prompt-bundle/v2",
      findings: [firstFinding, secondFinding],
    });

    const firstInput = {
      ...common,
      runId: "run-a",
    };
    const secondInput = {
      ...common,
      runId: "run-b",
      findings: [
        {
          ...secondFinding,
          createdAt: "2040-01-01T00:00:00.000Z",
        },
        {
          ...firstFinding,
          createdAt: "2041-01-01T00:00:00.000Z",
        },
      ],
    };
    const first = buildReviewReportHash(firstInput);
    const second = buildReviewReportHash(secondInput);

    expect(first).toBe(second);
  });

  test.each([
    ["policy", { policyHash: "d".repeat(64) }],
    ["provider", { providerName: "provider-b" }],
    ["model", { model: "model-b" }],
    ["prompt", { promptBundleVersion: "cq-prompt-bundle/v3" }],
  ])("binds %s identity into the report hash", (_label, override) => {
    const common = reportHashInput({
      runId: "ignored-run-id",
      snapshotContentHash: "a".repeat(64),
      contentBundleHash: "b".repeat(64),
      policyHash: "c".repeat(64),
      providerName: "provider-a",
      model: "model-a",
      promptBundleVersion: "cq-prompt-bundle/v2",
    });

    expect(buildReviewReportHash(common)).not.toBe(
      buildReviewReportHash({ ...common, ...override }),
    );
  });

  test("binds gate, incompleteness, bounded diagnostics, and scoring semantics", () => {
    const common = reportHashInput();
    const providerFailure = reportHashInput({
      gate: "INCOMPLETE",
      incomplete: true,
      scoreGate: "INCOMPLETE",
      diagnostics: [
        {
          code: "PROVIDER_FAILED",
          stageId: "behavior",
          message: "Provider failed after bounded retries",
        },
      ],
    });
    const differentDiagnostic = reportHashInput({
      ...providerFailure,
      diagnostics: [
        {
          code: "PROVIDER_TIMEOUT",
          stageId: "behavior",
          message: "Provider timed out after bounded retries",
        },
      ],
    });
    const scored = reportHashInput({
      scoringMode: "scored",
      scoreGate: "WARN",
      assessments: [
        {
          minorId: "primary-path",
          status: "scored",
          rating: 2.5,
          confidence: "high",
          evidence: ["finding-1:src/value.ts:source evidence"],
          explanation: "Confirmed finding caps the rating",
        },
      ],
    });

    expect(buildReviewReportHash(common)).not.toBe(
      buildReviewReportHash(providerFailure),
    );
    expect(buildReviewReportHash(providerFailure)).not.toBe(
      buildReviewReportHash(differentDiagnostic),
    );
    expect(buildReviewReportHash(common)).not.toBe(
      buildReviewReportHash(scored),
    );
  });

  test("canonicalizes semantic bucket, diagnostic, and assessment order", () => {
    const findingA = createFinding({
      id: "finding-a",
      title: "Finding A",
      severity: "P2",
      disposition: "new",
      confidence: "high",
      stages: ["behavior"],
      evidence: "Evidence A",
      impact: "Impact A",
      remediation: "Fix A",
      lifecycle: "confirmed",
    });
    const findingB = createFinding({
      id: "finding-b",
      title: "Finding B",
      severity: "P3",
      disposition: "new",
      confidence: "medium",
      stages: ["testing"],
      evidence: "Evidence B",
      impact: "Impact B",
      remediation: "Fix B",
      lifecycle: "confirmed",
    });
    const diagnostics = [
      {
        code: "PROVIDER_TIMEOUT" as const,
        stageId: "testing",
        message: "Timed out",
      },
      {
        code: "PROVIDER_FAILED" as const,
        stageId: "behavior",
        message: "Failed",
      },
    ];
    const first = reportHashInput({
      findings: [findingA, findingB],
      diagnostics,
    });
    const second = reportHashInput({
      findings: [findingB, findingA],
      diagnostics: [...diagnostics].reverse(),
    });

    expect(buildReviewReportHash(first)).toBe(buildReviewReportHash(second));
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

function reportHashInput(
  overrides: Partial<Parameters<typeof buildReviewReportHash>[0]> & {
    readonly runId?: string;
  } = {},
): Parameters<typeof buildReviewReportHash>[0] & { readonly runId?: string } {
  return {
    snapshotContentHash: "a".repeat(64),
    contentBundleHash: "b".repeat(64),
    policyHash: "c".repeat(64),
    providerName: "provider-a",
    model: "model-a",
    promptBundleVersion: "cq-prompt-bundle/v2",
    findings: [],
    gate: "PASS",
    incomplete: false,
    corroborated: [],
    uncertain: [],
    waived: [],
    diagnostics: [],
    scoringMode: "unscored",
    scoreGate: "PASS",
    assessments: [],
    ...overrides,
  };
}
