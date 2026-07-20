import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { EgressError } from "../core/egress.js";
import { canonicalizePolicy } from "../core/policy-values.js";
import {
  MAX_SNAPSHOT_EXCLUSIONS,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_PATH_BYTES,
} from "../core/snapshots.js";
import {
  collectRepositoryManifest,
  createRepositoryDiagnosticPreflight,
  createRepositoryPreflight,
  DEFAULT_REPOSITORY_BYTE_LIMIT,
  DEFAULT_REPOSITORY_ENTRY_LIMIT,
  DEFAULT_REPOSITORY_FILE_LIMIT,
  DEFAULT_REPOSITORY_INDIVIDUAL_FILE_BYTES,
  reconfirmRepository,
  RepositoryManifestError,
  repositoryCaptureToReviewInput,
} from "../git/repository-manifest.js";
import type { ResolvedReviewProvider } from "../providers/resolve.js";
import {
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_TOTAL_BYTES,
} from "../review/context.js";
import {
  createExecutionDescriptor,
  type ExecutionDescriptor,
  ExecutionDescriptorError,
} from "../review/execution-descriptor.js";
import type { ReviewRunResult } from "../review/orchestrator.js";
import {
  bindReviewPolicy,
  type BoundReviewPolicy,
  PolicyBindingError,
} from "../review/policy-binding.js";
import {
  ProfileScoreModelError,
  scoreModelFingerprint,
} from "../review/profile-score-model.js";
import type { RunCheckCommand } from "../review/run-checks.js";
import type { ScoreModel } from "../core/scoring.js";
import type { ImmutableReviewInput } from "../core/review-input.js";
import type { ReviewCommandOptions, ReviewCommandResult } from "./review.js";

const ORDINARY_STAGE_OUTPUT_TOKENS = 2_000;
const SCORED_STAGE_OUTPUT_TOKENS = 12_000;

type ProviderResolution =
  | { readonly ok: true; readonly value: ResolvedReviewProvider }
  | { readonly ok: false; readonly result: ReviewCommandResult };

interface RepositoryExecutionRequest {
  readonly command: ReviewCommandOptions;
  readonly input: ImmutableReviewInput;
  readonly provider: ResolvedReviewProvider;
  readonly descriptor: ExecutionDescriptor;
  readonly scoreModel: ScoreModel;
}

interface RepositoryReviewRuntime {
  resolveProvider(
    options: ReviewCommandOptions,
    validateConfiguration: boolean,
  ): Promise<ProviderResolution>;
  validateProvider(
    provider: ResolvedReviewProvider,
  ): Promise<ReviewCommandResult | undefined>;
  executeReview(request: RepositoryExecutionRequest): Promise<ReviewRunResult>;
  render(
    result: ReviewRunResult,
    options: ReviewCommandOptions,
    provider: ResolvedReviewProvider,
  ): Promise<ReviewCommandResult>;
}

function repositoryCaptureError(error: unknown): ReviewCommandResult {
  if (!(error instanceof RepositoryManifestError)) throw error;
  if (error.code === "REPOSITORY_SOURCE_STALE") {
    return {
      exitCode: 3,
      output: `Gate: INCOMPLETE\n${error.message}\n`,
    };
  }
  return { exitCode: 2, output: `${error.message}\n` };
}

function defaultCheckCommands(cwd: string): readonly RunCheckCommand[] {
  return Object.freeze([
    {
      label: "typecheck",
      argv: ["corepack", "pnpm", "exec", "tsc", "--noEmit"],
      cwd,
      timeoutMs: 60_000,
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 64 * 1024,
    },
  ]);
}

function policyCheckCommands(
  policy: BoundReviewPolicy,
  cwd: string,
): readonly RunCheckCommand[] {
  if (policy.qualityCommands.length === 0) return defaultCheckCommands(cwd);
  return Object.freeze(
    policy.qualityCommands.map((command) =>
      Object.freeze({
        ...command,
        argv: Object.freeze([...command.argv]),
        cwd,
      }),
    ),
  );
}

function commandsHash(commands: readonly RunCheckCommand[]): string {
  return createHash("sha256")
    .update("cq-run-check-commands/v1\0", "utf8")
    .update(canonicalizePolicy(commands), "utf8")
    .digest("hex");
}

function repositoryExecutionDescriptor(options: {
  readonly command: ReviewCommandOptions;
  readonly repository: string;
  readonly policy: BoundReviewPolicy;
  readonly provider: ResolvedReviewProvider;
}): ExecutionDescriptor {
  const { command, policy, provider } = options;
  if (
    command.policyHash !== undefined &&
    command.policyHash !== policy.policyHash
  ) {
    throw new ExecutionDescriptorError(
      "Full-repository policy hash override does not match effective policy",
    );
  }
  if (
    policy.providerName !== undefined &&
    policy.providerName !== provider.providerName
  ) {
    throw new ExecutionDescriptorError(
      "Selected provider does not match effective policy",
    );
  }
  if (policy.model !== undefined && policy.model !== provider.model) {
    throw new ExecutionDescriptorError(
      "Selected model does not match effective policy",
    );
  }
  const execution = command.reviewPreset ?? "full";
  const stageCap = execution === "fast" ? 1 : 7;
  const concurrencyCap = execution === "fast" ? 1 : 2;
  const attemptCap = execution === "fast" ? 2 : 16;
  const scoreModel = command.scoreModel ?? policy.scoreModel;
  const runChecks = command.runChecks === true;
  const checkCommands =
    command.checkCommands ?? policyCheckCommands(policy, options.repository);
  return createExecutionDescriptor({
    policy: { hash: policy.policyHash },
    provider: {
      name: provider.providerName,
      kind: provider.kind,
      providerClass: provider.providerClass,
      trustedConfigIdentity: provider.trustedConfigIdentity,
    },
    model: provider.model,
    endpoint: {
      identity: provider.endpointIdentity,
      class: provider.endpointClass,
    },
    egress: { policy: provider.egressPolicy, class: provider.egressClass },
    dataClassification: command.dataClassification ?? policy.dataClassification,
    repository: {
      selector: "full_repository",
      limits: {
        maxFiles: DEFAULT_REPOSITORY_FILE_LIMIT,
        maxBytes: DEFAULT_REPOSITORY_BYTE_LIMIT,
        maxEntries: DEFAULT_REPOSITORY_ENTRY_LIMIT,
        maxIndividualFileBytes: DEFAULT_REPOSITORY_INDIVIDUAL_FILE_BYTES,
      },
    },
    context: {
      maxFiles: MAX_CONTEXT_FILES,
      maxFileBytes: MAX_CONTEXT_FILE_BYTES,
      maxTotalBytes: MAX_CONTEXT_TOTAL_BYTES,
      maxSnapshotFiles: MAX_SNAPSHOT_FILES,
      maxSnapshotExclusions: MAX_SNAPSHOT_EXCLUSIONS,
      maxSnapshotPathBytes: MAX_SNAPSHOT_PATH_BYTES,
    },
    budgets: {
      maxChangedFiles: policy.budgets.maxFiles,
      maxChangedLines: policy.budgets.maxChangedLines,
      maxDiffBytes: policy.budgets.maxDiffBytes,
      maxTokens: policy.budgets.maxTokens,
      maxOutputTokens:
        command.maxOutputTokens ??
        (command.score === true
          ? SCORED_STAGE_OUTPUT_TOKENS
          : ORDINARY_STAGE_OUTPUT_TOKENS),
      maxDurationMs: command.timeoutMs ?? policy.budgets.timeoutSeconds * 1_000,
      maxCostUsd: policy.budgets.maxCostUsd,
      maxAttempts: Math.min(policy.budgets.maxProviderAttempts, attemptCap),
      maxInFlight: Math.min(
        policy.budgets.maxProviderConcurrency,
        concurrencyCap,
      ),
      maxStages: Math.min(policy.budgets.maxStages, stageCap),
    },
    score: {
      enabled: command.score === true,
      mode: command.score === true ? "score" : "review",
      modelFingerprint: scoreModelFingerprint(scoreModel),
      modelVersion: scoreModel.version,
    },
    verification: {
      required: true,
      runChecks: {
        enabled: runChecks,
        previewOnly: command.runChecksPreviewOnly === true,
        commandsHash: runChecks ? commandsHash(checkCommands) : null,
      },
    },
    gate: policy.gate,
  });
}

function providerRequested(
  options: ReviewCommandOptions,
  policy: BoundReviewPolicy,
): boolean {
  return (
    options.provider !== undefined ||
    options.providerName !== undefined ||
    options.model !== undefined ||
    options.configPath !== undefined ||
    policy.providerName !== undefined ||
    policy.model !== undefined
  );
}

function providerOptions(
  options: ReviewCommandOptions,
  policy: BoundReviewPolicy,
): ReviewCommandOptions {
  return {
    ...options,
    ...(options.providerName === undefined && policy.providerName !== undefined
      ? { providerName: policy.providerName }
      : {}),
    ...(options.model === undefined && policy.model !== undefined
      ? { model: policy.model }
      : {}),
  };
}

async function bindRepositoryPolicy(options: {
  readonly repository: string;
  readonly configPath?: string;
}): Promise<
  | {
      readonly ok: true;
      readonly repository: string;
      readonly policy: BoundReviewPolicy;
    }
  | { readonly ok: false; readonly result: ReviewCommandResult }
> {
  try {
    const repository = await realpath(options.repository);
    const policy = await bindReviewPolicy({
      repository,
      ...(options.configPath === undefined
        ? {}
        : { configPath: options.configPath }),
    });
    return { ok: true, repository, policy };
  } catch (error) {
    if (
      error instanceof PolicyBindingError ||
      error instanceof ProfileScoreModelError
    ) {
      return {
        ok: false,
        result: { exitCode: 2, output: `${error.message}\n` },
      };
    }
    return {
      ok: false,
      result: { exitCode: 2, output: "Repository policy could not be bound\n" },
    };
  }
}

function renderPreflight(
  preflight:
    | ReturnType<typeof createRepositoryDiagnosticPreflight>
    | ReturnType<typeof createRepositoryPreflight>,
  format: ReviewCommandOptions["format"],
): string {
  if (format === "json") return `${JSON.stringify(preflight, null, 2)}\n`;
  const execution = preflight.confirmable
    ? [
        `providerClass: ${preflight.providerClass}`,
        `endpointClass: ${preflight.endpointClass}`,
        `egressClass: ${preflight.egressClass}`,
        `confirmationHash: ${preflight.confirmationHash}`,
      ]
    : ["confirmable: no"];
  return [
    "Full-repository preflight",
    `repository: ${preflight.repository}`,
    `head: ${preflight.head}`,
    `selected: ${String(preflight.selectedFileCount)} files / ${String(preflight.selectedByteCount)} bytes`,
    `incomplete: ${preflight.incomplete ? "yes" : "no"}`,
    ...execution,
    "",
  ].join("\n");
}

function manifestRequest(repository: string, options: ReviewCommandOptions) {
  return {
    repository,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.repositoryIo === undefined ? {} : { io: options.repositoryIo }),
  };
}

export async function runRepositoryReview(
  options: ReviewCommandOptions,
  runtime: RepositoryReviewRuntime,
): Promise<ReviewCommandResult> {
  const selectedRepository =
    options.repository === true ? "." : (options.repository ?? ".");
  const binding = await bindRepositoryPolicy({
    repository: selectedRepository,
    ...(options.configPath === undefined
      ? {}
      : { configPath: options.configPath }),
  });
  if (!binding.ok) return binding.result;

  const { policy, repository } = binding;
  if (options.runChecks === true) {
    return {
      exitCode: 2,
      output:
        "Full-repository run-checks are not supported until they can execute against the confirmed snapshot\n",
    };
  }
  if (options.preflight === true && !providerRequested(options, policy)) {
    try {
      const capture = await collectRepositoryManifest(
        manifestRequest(repository, options),
      );
      const preflight = createRepositoryDiagnosticPreflight(capture);
      return {
        exitCode: preflight.incomplete ? 3 : 0,
        output: renderPreflight(preflight, options.format),
      };
    } catch (error) {
      return repositoryCaptureError(error);
    }
  }

  const resolution = await runtime.resolveProvider(
    providerOptions(options, policy),
    false,
  );
  if (!resolution.ok) return resolution.result;
  const provider = resolution.value;
  let descriptor: ExecutionDescriptor;
  try {
    descriptor = repositoryExecutionDescriptor({
      command: options,
      repository,
      policy,
      provider,
    });
  } catch (error) {
    if (
      error instanceof ExecutionDescriptorError ||
      error instanceof ProfileScoreModelError
    ) {
      return { exitCode: 2, output: `${error.message}\n` };
    }
    throw error;
  }

  const request = manifestRequest(repository, options);
  if (options.preflight === true) {
    try {
      const capture = await collectRepositoryManifest(
        request,
        descriptor,
        descriptor.repository.limits,
      );
      const preflight = createRepositoryPreflight(capture, descriptor);
      return {
        exitCode: preflight.incomplete ? 3 : 0,
        output: renderPreflight(preflight, options.format),
      };
    } catch (error) {
      return repositoryCaptureError(error);
    }
  }
  if (options.confirmFullRepository === undefined) {
    return {
      exitCode: 2,
      output:
        "Full-repository review requires --preflight or --confirm-full-repository <hash>\n",
    };
  }

  let capture;
  try {
    capture = await reconfirmRepository(
      options.confirmFullRepository,
      request,
      descriptor,
      descriptor.repository.limits,
    );
  } catch (error) {
    return repositoryCaptureError(error);
  }
  const providerError = await runtime.validateProvider(provider);
  if (providerError !== undefined) return providerError;
  try {
    const input = repositoryCaptureToReviewInput(capture);
    const scoreModel = options.scoreModel ?? policy.scoreModel;
    const result = await runtime.executeReview({
      command: options,
      input,
      provider,
      descriptor,
      scoreModel,
    });
    return await runtime.render(result, options, provider);
  } catch (error) {
    if (
      error instanceof EgressError ||
      error instanceof ProfileScoreModelError
    ) {
      return { exitCode: 2, output: `${error.message}\n` };
    }
    throw error;
  }
}
