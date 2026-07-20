import { createHash, randomUUID } from "node:crypto";

import {
  decideGate,
  dedupeFindings,
  sortFindings,
  stableFindingProjection,
  type Finding,
  type FindingGate,
} from "../core/findings.js";
import { compareCodeUnits } from "../core/deterministic-order.js";
import { canonicalizePolicy } from "../core/policy-values.js";
import { DEFAULT_SCORE_MODEL } from "../core/scoring-model.js";
import type {
  Assessment,
  ScoreModel,
  ScoreResult,
} from "../core/scoring-types.js";
import type { ReviewSnapshot } from "../core/snapshots.js";
import type {
  ReviewProvider,
  ReviewProviderSession,
} from "../providers/provider.js";
import type { ReviewContextBundle } from "./context.js";
import {
  createAssessmentPlan,
  type ReviewAssessmentPlan,
  unroutedAssessments,
} from "./assessment-plan.js";
import {
  planReview,
  type ReviewExecutionPreset,
  type ReviewPlan,
} from "./planner.js";
import { PROMPT_BUNDLE_VERSION } from "./prompts.js";
import {
  assessmentsFromReview,
  scoreFromReview,
  scoreGateFromReview,
} from "./score-bridge.js";
import {
  executeReviewStage,
  type AttemptReservation,
  type ReviewDiagnostic,
  type StageExecutionResult,
} from "./stage-output.js";
import type { BlockingEvidenceVerifier } from "./verifier.js";

export interface ReviewRunResult {
  readonly runId: string;
  readonly gate: FindingGate;
  readonly findings: readonly Finding[];
  readonly corroborated: readonly Finding[];
  readonly uncertain: readonly Finding[];
  readonly waived: readonly Finding[];
  /** Present on live runs; optional only for legacy sanitized cache records. */
  readonly diagnostics?: readonly ReviewDiagnostic[];
  readonly plan: ReviewPlan;
  readonly snapshot: ReviewSnapshot;
  readonly incomplete: boolean;
  readonly providerAttempts: number;
  readonly promptBundleVersion: string;
  readonly reportHash: string;
  readonly contentBundleHash: string;
  readonly assessments: readonly Assessment[];
  readonly scoreGate: ReturnType<typeof scoreGateFromReview>;
  readonly contextIncomplete: boolean;
  readonly cacheKey?: string;
  readonly fromCache?: boolean;
  readonly score?: ScoreResult;
}

type ReviewRunWithoutHash = Omit<ReviewRunResult, "reportHash">;

export interface ReviewOrchestratorOptions {
  readonly provider: ReviewProvider;
  readonly snapshot: ReviewSnapshot;
  readonly contentBundleHash: string;
  readonly context?: ReviewContextBundle;
  readonly model?: string;
  readonly providerName?: string;
  readonly blockingEvidenceVerifier?: BlockingEvidenceVerifier;
  readonly policyHash?: string;
  readonly signal?: AbortSignal;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly cacheKey?: string;
  readonly execution?: ReviewExecutionPreset;
  readonly computeScore?: boolean;
  readonly scoreModel?: ScoreModel;
  readonly maxStages?: number;
  readonly maxInFlight?: number;
  readonly maxAttempts?: number;
  readonly gatePolicy?: {
    readonly mode: "advisory" | "block" | "warn";
    readonly blockSeverity: "P0" | "P1" | "P2";
    readonly minimumConfidence: "deterministic" | "high" | "low" | "medium";
  };
}

interface AttemptAllocator {
  reserve(): AttemptReservation | undefined;
  used(): number;
}

function orchestratorPlan(options: ReviewOrchestratorOptions): ReviewPlan {
  return planReview(options.snapshot, {
    ...(options.execution === undefined
      ? {}
      : { execution: options.execution }),
    ...(options.maxStages === undefined
      ? {}
      : { maxStages: options.maxStages }),
    ...(options.maxInFlight === undefined
      ? {}
      : { maxInFlight: options.maxInFlight }),
    ...(options.maxAttempts === undefined
      ? {}
      : { maxAttempts: options.maxAttempts }),
  });
}

function orchestratorAssessmentPlan(
  options: ReviewOrchestratorOptions,
  plan: ReviewPlan,
): ReviewAssessmentPlan | undefined {
  if (options.computeScore !== true) return undefined;
  return createAssessmentPlan(
    plan.stages,
    options.scoreModel ?? DEFAULT_SCORE_MODEL,
  );
}

async function openProviderSession(
  options: ReviewOrchestratorOptions,
  runId: string,
  signal: AbortSignal,
): Promise<ReviewProviderSession | undefined> {
  if (options.provider.openReviewSession === undefined) return undefined;
  return options.provider.openReviewSession({
    runId,
    signal,
    deadline: Date.now() + (options.timeoutMs ?? 30_000),
  });
}

function optionsForAssessmentPlan(
  options: ReviewOrchestratorOptions,
  assessmentPlan: ReviewAssessmentPlan | undefined,
): ReviewOrchestratorOptions & {
  readonly assessmentPlan?: ReviewAssessmentPlan;
} {
  if (assessmentPlan === undefined) return options;
  return { ...options, assessmentPlan };
}

function exhaustedStageResult(stageId: string): StageExecutionResult {
  return {
    findings: [],
    diagnostics: [
      {
        code: "PROVIDER_ATTEMPT_BUDGET_EXHAUSTED",
        stageId,
        message: "Global provider attempt budget is exhausted",
      },
    ],
    incomplete: true,
  };
}

export function buildReviewReportHash(parts: {
  readonly snapshotContentHash: string;
  readonly contentBundleHash: string;
  readonly policyHash: string;
  readonly providerName: string;
  readonly model: string;
  readonly promptBundleVersion: string;
  readonly gate: FindingGate;
  readonly incomplete: boolean;
  readonly findings: readonly Finding[];
  readonly corroborated: readonly Finding[];
  readonly uncertain: readonly Finding[];
  readonly waived: readonly Finding[];
  readonly diagnostics: readonly ReviewDiagnostic[];
  readonly scoringMode: "unscored" | "scored";
  readonly scoreGate: ReviewRunResult["scoreGate"];
  readonly assessments: readonly Assessment[];
  readonly score?: ScoreResult;
}): string {
  const canonicalItems = (items: readonly unknown[]): readonly string[] =>
    items.map(canonicalizePolicy).sort(compareCodeUnits);
  const findingBucket = (findings: readonly Finding[]): readonly string[] =>
    canonicalItems(findings.map(stableFindingProjection));
  const diagnostics = canonicalItems(
    parts.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      stageId: diagnostic.stageId,
      path: diagnostic.path ?? null,
      message: diagnostic.message,
    })),
  );
  const assessments = canonicalItems(parts.assessments);
  const canonical = canonicalizePolicy({
    snapshotContentHash: parts.snapshotContentHash,
    contentBundleHash: parts.contentBundleHash,
    policyHash: parts.policyHash,
    providerName: parts.providerName,
    model: parts.model,
    promptBundleVersion: parts.promptBundleVersion,
    gate: parts.gate,
    incomplete: parts.incomplete,
    buckets: {
      confirmed: findingBucket(parts.findings),
      corroborated: findingBucket(parts.corroborated),
      uncertain: findingBucket(parts.uncertain),
      waived: findingBucket(parts.waived),
    },
    diagnostics,
    scoring: {
      mode: parts.scoringMode,
      scoreGate: parts.scoreGate,
      assessments,
      score: parts.score ?? null,
    },
  });
  return createHash("sha256")
    .update("cq-review-report/v4\0")
    .update(canonical, "utf8")
    .digest("hex");
}

function createAttemptAllocator(maxAttempts: number): AttemptAllocator {
  let available = maxAttempts;
  let used = 0;
  return {
    reserve(): AttemptReservation | undefined {
      if (available < 1) return undefined;
      const limit: 1 | 2 = available === 1 ? 1 : 2;
      available -= limit;
      let settled = false;
      return {
        limit,
        settle(consumed: number): void {
          if (settled) throw new Error("Attempt reservation already settled");
          if (!Number.isInteger(consumed) || consumed < 0 || consumed > limit) {
            throw new Error("Attempt reservation settlement is invalid");
          }
          settled = true;
          used += consumed;
          available += limit - consumed;
        },
      };
    },
    used: () => used,
  };
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        const item = items[index];
        if (item !== undefined) results[index] = await worker(item);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function categorizeFindings(findings: readonly Finding[]): {
  readonly confirmed: readonly Finding[];
  readonly corroborated: readonly Finding[];
  readonly uncertain: readonly Finding[];
  readonly waived: readonly Finding[];
} {
  const deduped = dedupeFindings(findings);
  return {
    confirmed: sortFindings(
      deduped.filter(
        (finding) =>
          finding.lifecycle === "confirmed" || finding.lifecycle === "reported",
      ),
    ),
    corroborated: sortFindings(
      deduped.filter((finding) => finding.lifecycle === "corroborated"),
    ),
    uncertain: sortFindings(
      deduped.filter((finding) => finding.lifecycle === "uncertain"),
    ),
    waived: sortFindings(
      deduped.filter((finding) => finding.lifecycle === "waived"),
    ),
  };
}

function attachAssessmentsAndScore(
  options: ReviewOrchestratorOptions,
  provisional: ReviewRunWithoutHash,
): ReviewRunWithoutHash {
  if (options.computeScore !== true) {
    return Object.freeze({
      ...provisional,
      assessments: Object.freeze([]),
      scoreGate: scoreGateFromReview(provisional),
    });
  }
  const model = options.scoreModel ?? DEFAULT_SCORE_MODEL;
  const assessments = assessmentsFromReview(provisional, model);
  const resultDocument: ReviewRunWithoutHash = {
    ...provisional,
    assessments,
    scoreGate: scoreGateFromReview(provisional),
  };
  const result = Object.freeze(resultDocument);
  const score = scoreFromReview(result, model);
  const scoredDocument: ReviewRunWithoutHash = {
    ...result,
    score,
    scoreGate: score.gate,
  };
  return Object.freeze(scoredDocument);
}

function finalizeResult(
  options: ReviewOrchestratorOptions,
  runId: string,
  plan: ReviewPlan,
  providerAttempts: number,
  stageResults: readonly StageExecutionResult[],
  assessmentPlan?: ReviewAssessmentPlan,
): ReviewRunResult {
  const categorized = categorizeFindings(
    stageResults.flatMap((result) => result.findings),
  );
  const executionIncomplete =
    options.snapshot.incomplete ||
    options.context?.incomplete === true ||
    stageResults.some((result) => result.incomplete) ||
    categorized.corroborated.some(
      (finding) => finding.blockingVerificationUnresolved === true,
    );
  const gateInput = {
    findings: categorized.confirmed,
    incomplete: executionIncomplete,
    ...(options.gatePolicy === undefined
      ? {}
      : {
          gateMode: options.gatePolicy.mode,
          blockSeverity: options.gatePolicy.blockSeverity,
          minimumConfidence: options.gatePolicy.minimumConfidence,
        }),
  };
  const gate = decideGate(gateInput);
  const provisional = {
    runId,
    gate,
    findings: categorized.confirmed,
    corroborated: categorized.corroborated,
    uncertain: categorized.uncertain,
    waived: categorized.waived,
    diagnostics: Object.freeze(
      stageResults.flatMap((result) => result.diagnostics),
    ),
    plan,
    snapshot: options.snapshot,
    incomplete: executionIncomplete,
    providerAttempts,
    promptBundleVersion: PROMPT_BUNDLE_VERSION,
    contentBundleHash: options.contentBundleHash,
    assessments: Object.freeze([
      ...stageResults.flatMap((result) => result.assessments ?? []),
      ...(assessmentPlan === undefined
        ? []
        : unroutedAssessments(assessmentPlan)),
    ]),
    scoreGate: "INCOMPLETE" as const,
    contextIncomplete: options.context?.incomplete === true,
    ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
  } satisfies ReviewRunWithoutHash;
  const result = attachAssessmentsAndScore(options, provisional);
  const reportHash = buildReviewReportHash({
    snapshotContentHash: options.snapshot.contentHash,
    contentBundleHash: options.contentBundleHash,
    policyHash: options.policyHash ?? "unbound-policy",
    providerName: options.providerName ?? "unknown-provider",
    model: options.model ?? "default",
    promptBundleVersion: PROMPT_BUNDLE_VERSION,
    gate: result.gate,
    incomplete: result.incomplete,
    findings: result.findings,
    corroborated: result.corroborated,
    uncertain: result.uncertain,
    waived: result.waived,
    diagnostics: result.diagnostics ?? [],
    scoringMode: options.computeScore === true ? "scored" : "unscored",
    scoreGate: result.scoreGate,
    assessments: result.assessments,
    ...(result.score === undefined ? {} : { score: result.score }),
  });
  return Object.freeze({ ...result, reportHash });
}

export async function runReview(
  options: ReviewOrchestratorOptions,
): Promise<ReviewRunResult> {
  const runId = randomUUID();
  const plan = orchestratorPlan(options);
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) controller.abort();
  const attempts = createAttemptAllocator(plan.maxAttempts);
  const assessmentPlan = orchestratorAssessmentPlan(options, plan);
  const executionOptions = optionsForAssessmentPlan(options, assessmentPlan);
  let providerSession: ReviewProviderSession | undefined;
  try {
    providerSession = await openProviderSession(
      options,
      runId,
      controller.signal,
    );
    const results = await mapPool(
      plan.stages,
      plan.maxInFlight,
      async (stage) => {
        if (controller.signal.aborted) {
          return { findings: [], diagnostics: [], incomplete: true };
        }
        const reservation = attempts.reserve();
        if (reservation === undefined) return exhaustedStageResult(stage);
        return executeReviewStage(
          executionOptions,
          runId,
          stage,
          controller.signal,
          reservation,
        );
      },
    );
    return finalizeResult(
      options,
      runId,
      plan,
      attempts.used(),
      results,
      assessmentPlan,
    );
  } finally {
    try {
      await providerSession?.release();
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}
