import { realpath } from "node:fs/promises";

import { EgressError } from "../core/egress.js";
import type { PolicyQualityCommand } from "../core/policy-types.js";
import type { ImmutableReviewInput } from "../core/review-input.js";
import { captureLocalGitReviewInput, GitInputError } from "../git/inputs.js";
import type { ResolvedReviewProvider } from "../providers/resolve.js";
import { materializeStagedCheckWorkspace } from "../review/check-workspace.js";
import type { ReviewRunResult } from "../review/orchestrator.js";
import {
  bindReviewPolicy,
  type BoundReviewPolicy,
} from "../review/policy-binding.js";
import { ProfileScoreModelError } from "../review/profile-score-model.js";
import {
  RunChecksError,
  runAuthorizedChecks,
  type RunCheckCommand,
} from "../review/run-checks.js";
import type { ReviewCommandOptions, ReviewCommandResult } from "./review.js";

type ProviderResolution =
  | { readonly ok: true; readonly value: ResolvedReviewProvider }
  | { readonly ok: false; readonly result: ReviewCommandResult };

interface LocalReviewExecutionRequest {
  readonly command: ReviewCommandOptions;
  readonly input: ImmutableReviewInput;
  readonly provider: ResolvedReviewProvider;
  readonly policy: BoundReviewPolicy | undefined;
  readonly checksFailed: boolean;
}

interface LocalReviewRuntime {
  resolveProvider(options: ReviewCommandOptions): Promise<ProviderResolution>;
  executeReview(request: LocalReviewExecutionRequest): Promise<ReviewRunResult>;
  render(
    result: ReviewRunResult,
    options: ReviewCommandOptions,
    provider: ResolvedReviewProvider,
  ): Promise<ReviewCommandResult>;
}

type LocalPolicyBinding =
  | { readonly ok: true; readonly policy: BoundReviewPolicy | undefined }
  | { readonly ok: false; readonly result: ReviewCommandResult };

type LocalCheckOutcome =
  | { readonly kind: "executed"; readonly failed: boolean }
  | { readonly kind: "result"; readonly result: ReviewCommandResult };

async function resolveLocalPolicy(
  options: ReviewCommandOptions,
): Promise<LocalPolicyBinding> {
  try {
    const repository = await realpath(".");
    const policy = await bindReviewPolicy({
      repository,
      ...(options.configPath === undefined
        ? {}
        : { configPath: options.configPath }),
    });
    return { ok: true, policy };
  } catch (error) {
    if (error instanceof ProfileScoreModelError) {
      return {
        ok: false,
        result: { exitCode: 2, output: `${error.message}\n` },
      };
    }
    return { ok: true, policy: undefined };
  }
}

function providerOptions(
  options: ReviewCommandOptions,
  policy: BoundReviewPolicy | undefined,
): ReviewCommandOptions {
  return {
    ...options,
    ...(options.providerName === undefined && policy?.providerName !== undefined
      ? { providerName: policy.providerName }
      : {}),
    ...(options.model === undefined && policy?.model !== undefined
      ? { model: policy.model }
      : {}),
  };
}

async function captureInput(
  options: ReviewCommandOptions,
): Promise<ImmutableReviewInput | ReviewCommandResult> {
  try {
    return await captureLocalGitReviewInput(
      {
        repository: ".",
        ...(options.worktree === true ? { worktree: true } : {}),
        ...(options.staged === true ? { staged: true } : {}),
        ...(options.commit === undefined ? {} : { commit: options.commit }),
        ...(options.range === undefined ? {} : { range: options.range }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      options.localGitIo,
    );
  } catch (error) {
    if (!(error instanceof GitInputError)) throw error;
    return {
      exitCode: error.code === "GIT_SOURCE_STALE" ? 3 : 2,
      output:
        error.code === "GIT_SOURCE_STALE"
          ? `Gate: INCOMPLETE\n${error.message}\n`
          : `${error.message}\n`,
    };
  }
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
  commands: readonly PolicyQualityCommand[],
  cwd: string,
): readonly RunCheckCommand[] {
  return Object.freeze(
    commands.map((command) =>
      Object.freeze({
        ...command,
        argv: Object.freeze([...command.argv]),
        cwd,
      }),
    ),
  );
}

async function runLocalChecks(options: {
  readonly command: ReviewCommandOptions;
  readonly input: ImmutableReviewInput;
  readonly policy: BoundReviewPolicy | undefined;
}): Promise<LocalCheckOutcome> {
  let workspace: Awaited<
    ReturnType<typeof materializeStagedCheckWorkspace>
  > | null = null;
  try {
    const repository = await realpath(".");
    if (
      options.command.staged === true &&
      options.command.runChecksPreviewOnly !== true
    ) {
      workspace = await materializeStagedCheckWorkspace({
        repository,
        input: options.input,
        ...(options.command.signal === undefined
          ? {}
          : { signal: options.command.signal }),
      });
    }
    const cwd = workspace?.path ?? repository;
    const checks = await runAuthorizedChecks({
      authorized: true,
      previewOnly: options.command.runChecksPreviewOnly === true,
      ...(options.command.signal === undefined
        ? {}
        : { signal: options.command.signal }),
      ...(options.policy === undefined
        ? {}
        : {
            totalTimeoutMs: Math.min(
              options.policy.budgets.timeoutSeconds * 1_000,
              300_000,
            ),
          }),
      commands:
        options.command.checkCommands ??
        (options.policy !== undefined &&
        options.policy.qualityCommands.length > 0
          ? policyCheckCommands(options.policy.qualityCommands, cwd)
          : defaultCheckCommands(cwd)),
    });
    if (options.command.runChecksPreviewOnly === true) {
      return {
        kind: "result",
        result: {
          exitCode: 0,
          output: `Run-checks preview:\n${checks.preview}\n`,
        },
      };
    }
    return {
      kind: "executed",
      failed:
        checks.results?.some(
          (item) => item.timedOut || item.truncated || item.exitCode !== 0,
        ) === true,
    };
  } catch (error) {
    return {
      kind: "result",
      result: {
        exitCode: 2,
        output:
          error instanceof RunChecksError
            ? `${error.message}\n`
            : "Run-checks failed\n",
      },
    };
  } finally {
    await workspace?.dispose();
  }
}

export async function runLocalReview(
  options: ReviewCommandOptions,
  runtime: LocalReviewRuntime,
): Promise<ReviewCommandResult> {
  const binding = await resolveLocalPolicy(options);
  if (!binding.ok) return binding.result;

  const resolution = await runtime.resolveProvider(
    providerOptions(options, binding.policy),
  );
  if (!resolution.ok) return resolution.result;
  const provider = resolution.value;

  const input = await captureInput(options);
  if (!("snapshot" in input)) return input;

  let checksFailed = false;
  if (options.runChecks === true) {
    const checks = await runLocalChecks({
      command: options,
      input,
      policy: binding.policy,
    });
    if (checks.kind === "result") return checks.result;
    checksFailed = checks.failed;
  }

  try {
    const result = await runtime.executeReview({
      command: options,
      input,
      provider,
      policy: binding.policy,
      checksFailed,
    });
    return await runtime.render(result, options, provider);
  } catch (error) {
    if (error instanceof EgressError) {
      return { exitCode: 2, output: `${error.message}\n` };
    }
    throw error;
  }
}
