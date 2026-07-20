import {
  assertEgressAllowed,
  type DataClassification,
} from "../core/egress.js";
import type { ImmutableReviewInput } from "../core/review-input.js";
import { DEFAULT_SCORE_MODEL, type ScoreModel } from "../core/scoring.js";
import { type ForgeTransport } from "../forges/forge.js";
import { type BasePolicyBinding } from "../review/base-policy.js";
import { type LocalGitInputIo } from "../git/inputs.js";
import { type RepositoryManifestIo } from "../git/repository-manifest.js";
import type { ReviewProvider } from "../providers/provider.js";
import {
  ProviderResolveError,
  resolveReviewProvider,
  type ResolvedReviewProvider,
} from "../providers/resolve.js";
import { collectReviewContext } from "../review/context.js";
import { type ExecutionDescriptor } from "../review/execution-descriptor.js";
import { runReview, type ReviewRunResult } from "../review/orchestrator.js";
import type { BoundReviewPolicy } from "../review/policy-binding.js";
import { scoreModelFingerprint } from "../review/profile-score-model.js";
import { scoreFromReview } from "../review/score-bridge.js";
import type { ReviewDiagnostic } from "../review/stage-output.js";
import type { BlockingEvidenceVerifier } from "../review/verifier.js";
import { type RunCheckCommand } from "../review/run-checks.js";
import {
  buildReviewCacheKey,
  runWithSingleFlight,
} from "../review/single-flight.js";
import { PROVIDER_ADAPTER_VERSION } from "../providers/soak.js";
import type { ReviewExecutionPreset, ReviewPlan } from "../review/planner.js";
import { PROMPT_BUNDLE_VERSION } from "../review/prompts.js";
import {
  RunStorageError,
  sanitizeRunRecord,
  storeRun,
  type SanitizeRunOptions,
  type StoredRunRecord,
} from "../storage/runs.js";
import type { CommandOutputFormat } from "./output.js";
import { runForgeReview } from "./review-forge.js";
import { runLocalReview } from "./review-local.js";
import { renderReviewCommandResult } from "./review-render.js";
import { runRepositoryReview } from "./review-repository.js";

function buildSanitizeRunOptions(
  resolved: ResolvedReviewProvider,
  policyHash: string,
  startedAt?: string,
): SanitizeRunOptions {
  return {
    policyHash,
    providerName: resolved.providerName,
    providerKind: resolved.kind,
    model: resolved.model,
    adapterVersion: PROVIDER_ADAPTER_VERSION,
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

function reviewExecutionExtras(options: ReviewCommandOptions): {
  readonly reviewPreset?: ReviewExecutionPreset;
  readonly hookPreset?: string;
  readonly computeScore?: boolean;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly scoreModel?: ScoreModel;
  readonly blockingEvidenceVerifier?: BlockingEvidenceVerifier;
} {
  return {
    ...(options.reviewPreset === undefined
      ? {}
      : { reviewPreset: options.reviewPreset }),
    ...(options.hookPreset === undefined
      ? {}
      : { hookPreset: options.hookPreset }),
    ...(options.score === true ? { computeScore: true } : {}),
    ...(options.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.score !== true || options.scoreModel === undefined
      ? {}
      : { scoreModel: options.scoreModel }),
    ...(options.blockingEvidenceVerifier === undefined
      ? {}
      : { blockingEvidenceVerifier: options.blockingEvidenceVerifier }),
  };
}

export interface ReviewCommandOptions {
  readonly worktree?: boolean;
  readonly staged?: boolean;
  readonly commit?: string;
  readonly range?: string;
  readonly repository?: string | true;
  readonly preflight?: boolean;
  readonly confirmFullRepository?: string;
  readonly repositoryIo?: RepositoryManifestIo;
  /** Trusted local Git capture hooks, primarily for embedders and tests. */
  readonly localGitIo?: LocalGitInputIo;
  readonly forgeUrl?: string;
  readonly format?: CommandOutputFormat | "markdown";
  readonly output?: string;
  readonly provider?: ReviewProvider;
  readonly providerName?: string;
  readonly model?: string;
  readonly configPath?: string;
  readonly publish?: boolean;
  readonly yes?: boolean;
  readonly publishTokenEnv?: string;
  readonly forgeTransport?: ForgeTransport;
  readonly runChecks?: boolean;
  readonly runChecksPreviewOnly?: boolean;
  readonly checkCommands?: readonly RunCheckCommand[];
  readonly dataClassification?: DataClassification;
  readonly policyHash?: string;
  readonly disableSingleFlight?: boolean;
  readonly signal?: AbortSignal;
  /** full (default) or fast (hook balanced pre-commit). */
  readonly reviewPreset?: ReviewExecutionPreset;
  /** Named hook preset included in cache key when present. */
  readonly hookPreset?: string;
  /** Compute and append the full 100.0 score model output. */
  readonly score?: boolean;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  /** Write a permission-restricted redacted transcript and mark the run sensitive. */
  readonly retainTranscript?: boolean;
  /** Trusted score-model injection, primarily for embedders and tests. */
  readonly scoreModel?: ScoreModel;
  /** Trusted deterministic/runtime verifier for blocking provider candidates. */
  readonly blockingEvidenceVerifier?: BlockingEvidenceVerifier;
}

export interface ReviewCommandResult {
  readonly exitCode: number;
  readonly output: string;
}

function fallbackReviewPlan(): ReviewPlan {
  return {
    stages: Object.freeze([
      "universal",
      "behavior",
      "readability",
      "testing",
      "concurrency",
    ] as const),
    signals: Object.freeze({}),
    maxInFlight: 2,
    maxAttempts: 16,
    execution: "full",
  };
}

function reviewFromCache(options: {
  readonly record: StoredRunRecord;
  readonly snapshot: ReviewRunResult["snapshot"];
  readonly contentBundleHash: string;
  readonly cacheKey: string;
  readonly computeScore: boolean;
  readonly scoreModel?: ScoreModel;
}): ReviewRunResult {
  const cached: ReviewRunResult = Object.freeze({
    runId: options.record.runId,
    gate: options.record.gate,
    findings: options.record.findings,
    corroborated: options.record.corroborated,
    uncertain: options.record.uncertain,
    waived: options.record.waived,
    diagnostics: options.record.diagnostics,
    plan: fallbackReviewPlan(),
    snapshot: options.snapshot,
    incomplete: options.record.incomplete,
    providerAttempts: options.record.providerAttempts,
    promptBundleVersion: options.record.promptBundleVersion,
    reportHash: options.record.reportHash,
    contentBundleHash: options.contentBundleHash,
    assessments: options.record.assessments,
    scoreGate: options.record.scoreGate,
    contextIncomplete: options.record.contextIncomplete,
    cacheKey: options.cacheKey,
    fromCache: true,
  });
  if (!options.computeScore) return cached;
  if (options.scoreModel === undefined) {
    throw new TypeError("Scored cache replay requires its full score model");
  }
  const score = scoreFromReview(cached, options.scoreModel);
  return Object.freeze({ ...cached, score, scoreGate: score.gate });
}

function incompleteFlightResult(
  snapshot: ReviewRunResult["snapshot"],
  contentBundleHash: string,
  cacheKey: string,
  failure: {
    readonly code: ReviewDiagnostic["code"];
    readonly message: string;
  },
): ReviewRunResult {
  return Object.freeze({
    runId: "00000000-0000-4000-8000-000000000000",
    gate: "INCOMPLETE",
    findings: Object.freeze([]),
    corroborated: Object.freeze([]),
    uncertain: Object.freeze([]),
    waived: Object.freeze([]),
    diagnostics: Object.freeze([
      {
        code: failure.code,
        message: failure.message,
        stageId: "storage",
      },
    ]),
    plan: fallbackReviewPlan(),
    snapshot,
    incomplete: true,
    providerAttempts: 0,
    promptBundleVersion: PROMPT_BUNDLE_VERSION,
    reportHash: cacheKey,
    contentBundleHash,
    assessments: Object.freeze([]),
    scoreGate: "INCOMPLETE",
    contextIncomplete: true,
    cacheKey,
    fromCache: false,
  });
}

interface ExecuteReviewOptions {
  readonly resolved: ResolvedReviewProvider;
  readonly input: ImmutableReviewInput;
  readonly dataClassification?: DataClassification;
  readonly policyHash?: string;
  readonly disableSingleFlight?: boolean;
  readonly signal?: AbortSignal;
  readonly reviewPreset?: ReviewExecutionPreset;
  readonly hookPreset?: string;
  readonly computeScore?: boolean;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly scoreModel?: ScoreModel;
  readonly blockingEvidenceVerifier?: BlockingEvidenceVerifier;
  readonly forceIncomplete?: boolean;
  readonly sensitiveTranscript?: boolean;
  readonly maxStages?: number;
  readonly maxInFlight?: number;
  readonly maxAttempts?: number;
  readonly contextLimits?: {
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
  };
  readonly gatePolicy?: {
    readonly mode: "advisory" | "block" | "warn";
    readonly blockSeverity: "P0" | "P1" | "P2";
    readonly minimumConfidence: "deterministic" | "high" | "low" | "medium";
  };
}

interface PreparedReviewExecution {
  readonly snapshot: ReviewRunResult["snapshot"];
  readonly context: Awaited<ReturnType<typeof collectReviewContext>>;
  readonly contentBundleHash: string;
  readonly execution: ReviewExecutionPreset;
  readonly scoreModel: ScoreModel | undefined;
  readonly cacheKey: string;
  readonly storageOptions: SanitizeRunOptions;
}

type ReviewFlightOutcome = Awaited<ReturnType<typeof runWithSingleFlight>>;

async function prepareReviewExecution(
  options: ExecuteReviewOptions,
): Promise<PreparedReviewExecution> {
  assertEgressAllowed(
    options.dataClassification ?? "internal",
    options.resolved.egressClass,
    options.resolved.providerClass,
  );

  const snapshot = options.input.snapshot;
  const context = await collectReviewContext(snapshot, {
    contentByPath: options.input.contentByPath,
    ...(options.contextLimits === undefined ? {} : options.contextLimits),
  });
  const policyHash = options.policyHash ?? "0".repeat(64);
  const startedAt = new Date().toISOString();
  const baseStorageOptions = buildSanitizeRunOptions(
    options.resolved,
    policyHash,
    startedAt,
  );
  const storageOptions: SanitizeRunOptions = {
    ...baseStorageOptions,
    ...(options.sensitiveTranscript === true
      ? { sensitiveTranscript: true }
      : {}),
  };
  const execution = options.reviewPreset ?? "full";
  const scoringMode = options.computeScore === true ? "score" : "review";
  const scoreModel =
    options.computeScore === true
      ? (options.scoreModel ?? DEFAULT_SCORE_MODEL)
      : undefined;
  const cachePreset =
    options.hookPreset === undefined
      ? execution
      : `${options.hookPreset}:${execution}`;
  const cacheKey = buildReviewCacheKey({
    repositoryIdentity: snapshot.repository,
    contentHash: snapshot.contentHash,
    contentBundleHash: options.input.contentBundleHash,
    providerName: options.resolved.providerName,
    model: options.resolved.model,
    policyHash,
    reviewMode: scoringMode,
    ...(scoreModel === undefined
      ? {}
      : { scoreModelFingerprint: scoreModelFingerprint(scoreModel) }),
    preset: cachePreset,
    adapterVersion: PROVIDER_ADAPTER_VERSION,
  });
  return {
    snapshot,
    context,
    contentBundleHash: options.input.contentBundleHash,
    execution,
    scoreModel,
    cacheKey,
    storageOptions,
  };
}

async function runFinalizedReview(
  options: ExecuteReviewOptions,
  prepared: PreparedReviewExecution,
): Promise<ReviewRunResult> {
  const result = await runReview({
    provider: options.resolved.provider,
    model: options.resolved.model,
    providerName: options.resolved.providerName,
    snapshot: prepared.snapshot,
    context: prepared.context,
    contentBundleHash: prepared.contentBundleHash,
    cacheKey: prepared.cacheKey,
    execution: prepared.execution,
    computeScore: options.computeScore === true,
    ...(prepared.scoreModel === undefined
      ? {}
      : { scoreModel: prepared.scoreModel }),
    ...(options.blockingEvidenceVerifier === undefined
      ? {}
      : { blockingEvidenceVerifier: options.blockingEvidenceVerifier }),
    ...(options.policyHash === undefined
      ? {}
      : { policyHash: options.policyHash }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.maxStages === undefined
      ? {}
      : { maxStages: options.maxStages }),
    ...(options.maxInFlight === undefined
      ? {}
      : { maxInFlight: options.maxInFlight }),
    ...(options.maxAttempts === undefined
      ? {}
      : { maxAttempts: options.maxAttempts }),
    ...(options.gatePolicy === undefined
      ? {}
      : { gatePolicy: options.gatePolicy }),
  });
  return options.forceIncomplete === true
    ? {
        ...result,
        incomplete: true,
        gate: "INCOMPLETE",
        scoreGate: "INCOMPLETE",
      }
    : result;
}

function mapFlightOutcome(
  flight: ReviewFlightOutcome,
  options: ExecuteReviewOptions,
  prepared: PreparedReviewExecution,
): ReviewRunResult {
  if (flight.kind === "executed") {
    return { ...flight.result, cacheKey: prepared.cacheKey, fromCache: false };
  }
  if (flight.kind === "cached") {
    return reviewFromCache({
      record: flight.record,
      snapshot: prepared.snapshot,
      contentBundleHash: prepared.contentBundleHash,
      cacheKey: prepared.cacheKey,
      computeScore: options.computeScore === true,
      ...(prepared.scoreModel === undefined
        ? {}
        : { scoreModel: prepared.scoreModel }),
    });
  }
  return incompleteFlightResult(
    prepared.snapshot,
    prepared.contentBundleHash,
    prepared.cacheKey,
    { code: flight.code, message: flight.reason },
  );
}

async function executeReview(
  options: ExecuteReviewOptions,
): Promise<ReviewRunResult> {
  const prepared = await prepareReviewExecution(options);
  const run = () => runFinalizedReview(options, prepared);

  const persistResult = async (result: ReviewRunResult): Promise<void> => {
    await storeRun(result, prepared.storageOptions);
  };

  if (options.disableSingleFlight === true) {
    const result = await run();
    try {
      await persistResult(result);
      return result;
    } catch (error) {
      if (!(error instanceof RunStorageError)) throw error;
      return incompleteFlightResult(
        prepared.snapshot,
        prepared.contentBundleHash,
        prepared.cacheKey,
        {
          code: error.code,
          message: `${error.message}; result cannot be retrieved with cq report`,
        },
      );
    }
  }

  const flight = await runWithSingleFlight({
    key: prepared.cacheKey,
    contentBundleHash: prepared.contentBundleHash,
    run,
    persistResult,
    toRecord: (result) => sanitizeRunRecord(result, prepared.storageOptions),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return mapFlightOutcome(flight, options, prepared);
}

async function resolveProviderOrError(
  options: ReviewCommandOptions,
  validateConfiguration = true,
): Promise<
  | { readonly ok: true; readonly value: ResolvedReviewProvider }
  | { readonly ok: false; readonly result: ReviewCommandResult }
> {
  try {
    const value = await resolveReviewProvider({
      ...(options.provider === undefined ? {} : { injected: options.provider }),
      ...(options.providerName === undefined
        ? {}
        : { providerName: options.providerName }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.configPath === undefined
        ? {}
        : { configPath: options.configPath }),
    });
    if (validateConfiguration && options.provider === undefined) {
      const diagnostics = await value.provider.validateConfiguration();
      if (diagnostics.length > 0) {
        return {
          ok: false,
          result: {
            exitCode: 2,
            output: `Provider configuration is invalid: ${diagnostics[0]?.message ?? "unknown"}\n`,
          },
        };
      }
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ProviderResolveError) {
      return {
        ok: false,
        result: {
          exitCode: 2,
          output: `${error.message}\n`,
        },
      };
    }
    return {
      ok: false,
      result: {
        exitCode: 2,
        output: "Provider configuration could not be resolved\n",
      },
    };
  }
}

async function validateProviderOrError(
  resolved: ResolvedReviewProvider,
): Promise<ReviewCommandResult | undefined> {
  try {
    const diagnostics = await resolved.provider.validateConfiguration();
    if (diagnostics.length === 0) return undefined;
    return {
      exitCode: 2,
      output: `Provider configuration is invalid: ${diagnostics[0]?.message ?? "unknown"}\n`,
    };
  } catch {
    return {
      exitCode: 2,
      output: "Provider configuration could not be validated\n",
    };
  }
}

function descriptorReviewOptions(
  descriptor: ExecutionDescriptor,
  options: ReviewCommandOptions,
  scoreModel: ScoreModel,
) {
  return {
    dataClassification: descriptor.dataClassification,
    policyHash: descriptor.policy.hash,
    reviewPreset: options.reviewPreset ?? ("full" as const),
    ...(options.hookPreset === undefined
      ? {}
      : { hookPreset: options.hookPreset }),
    ...(descriptor.score.enabled ? { computeScore: true, scoreModel } : {}),
    maxOutputTokens: descriptor.budgets.maxOutputTokens,
    timeoutMs: descriptor.budgets.maxDurationMs,
    maxStages: descriptor.budgets.maxStages,
    maxInFlight: descriptor.budgets.maxInFlight,
    maxAttempts: descriptor.budgets.maxAttempts,
    contextLimits: {
      maxFiles: descriptor.context.maxFiles,
      maxFileBytes: descriptor.context.maxFileBytes,
      maxTotalBytes: descriptor.context.maxTotalBytes,
    },
    gatePolicy: descriptor.gate,
    ...(options.blockingEvidenceVerifier === undefined
      ? {}
      : { blockingEvidenceVerifier: options.blockingEvidenceVerifier }),
    ...(options.disableSingleFlight === true
      ? { disableSingleFlight: true }
      : {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

async function executeBoundRepositoryReview(options: {
  readonly command: ReviewCommandOptions;
  readonly input: ImmutableReviewInput;
  readonly provider: ResolvedReviewProvider;
  readonly descriptor: ExecutionDescriptor;
  readonly scoreModel: ScoreModel;
}): Promise<ReviewRunResult> {
  return executeReview({
    resolved: options.provider,
    input: options.input,
    ...descriptorReviewOptions(
      options.descriptor,
      options.command,
      options.scoreModel,
    ),
  });
}

async function executeBoundForgeReview(options: {
  readonly command: ReviewCommandOptions;
  readonly input: ImmutableReviewInput;
  readonly provider: ResolvedReviewProvider;
  readonly basePolicy: BasePolicyBinding;
  readonly checksFailed: boolean;
}): Promise<ReviewRunResult> {
  return executeReview({
    resolved: options.provider,
    input: options.input,
    dataClassification:
      options.command.dataClassification ??
      options.basePolicy.dataClassification,
    policyHash: options.basePolicy.policyHash,
    ...reviewExecutionExtras(options.command),
    ...(options.command.score === true
      ? {
          scoreModel:
            options.command.scoreModel ?? options.basePolicy.scoreModel,
        }
      : {}),
    ...(options.command.disableSingleFlight === true
      ? { disableSingleFlight: true }
      : {}),
    ...(options.checksFailed ? { forceIncomplete: true } : {}),
    ...(options.command.signal === undefined
      ? {}
      : { signal: options.command.signal }),
  });
}

async function executeBoundLocalReview(options: {
  readonly command: ReviewCommandOptions;
  readonly input: ImmutableReviewInput;
  readonly provider: ResolvedReviewProvider;
  readonly policy: BoundReviewPolicy | undefined;
  readonly checksFailed: boolean;
}): Promise<ReviewRunResult> {
  const policyHash = options.command.policyHash ?? options.policy?.policyHash;
  const scoreModel = options.command.scoreModel ?? options.policy?.scoreModel;
  return executeReview({
    resolved: options.provider,
    input: options.input,
    dataClassification:
      options.command.dataClassification ??
      options.policy?.dataClassification ??
      "internal",
    ...reviewExecutionExtras(options.command),
    ...(options.command.score === true && scoreModel !== undefined
      ? { scoreModel }
      : {}),
    ...(policyHash === undefined ? {} : { policyHash }),
    ...(options.command.disableSingleFlight === true
      ? { disableSingleFlight: true }
      : {}),
    ...(options.checksFailed ? { forceIncomplete: true } : {}),
    ...(options.command.retainTranscript === true
      ? { sensitiveTranscript: true }
      : {}),
    ...(options.command.signal === undefined
      ? {}
      : { signal: options.command.signal }),
  });
}

export async function runReviewCommand(
  options: ReviewCommandOptions,
): Promise<ReviewCommandResult> {
  const selectors = [
    options.worktree === true,
    options.staged === true,
    options.commit !== undefined,
    options.range !== undefined,
    options.repository !== undefined,
    options.forgeUrl !== undefined,
  ].filter(Boolean);
  if (selectors.length !== 1) {
    return {
      exitCode: 2,
      output: "Exactly one review input selector is required\n",
    };
  }

  if (options.repository !== undefined) {
    return runRepositoryReview(options, {
      resolveProvider: resolveProviderOrError,
      validateProvider: validateProviderOrError,
      executeReview: executeBoundRepositoryReview,
      render: renderReviewCommandResult,
    });
  }
  if (options.forgeUrl !== undefined) {
    return runForgeReview(options, {
      resolveProvider: resolveProviderOrError,
      executeReview: executeBoundForgeReview,
      render: renderReviewCommandResult,
    });
  }
  return runLocalReview(options, {
    resolveProvider: resolveProviderOrError,
    executeReview: executeBoundLocalReview,
    render: renderReviewCommandResult,
  });
}
