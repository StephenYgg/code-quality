import { EgressError } from "../core/egress.js";
import type { ImmutableReviewInput } from "../core/review-input.js";
import {
  resolveForgeCredentials,
  type ForgeCredentials,
  type ForgeReadResult,
  type ForgeReader,
  type ForgeTransport,
} from "../forges/forge.js";
import { GitHubForgeReader } from "../forges/github.js";
import { GitLabForgeReader } from "../forges/gitlab.js";
import {
  ForgeMaterializeError,
  materializeForgeChange,
  type MaterializedForgeCheckout,
} from "../forges/materialize.js";
import {
  PublicationError,
  publishReviewComment,
  type PublicationTarget,
} from "../forges/publish.js";
import { parseForgeUrl, type ParsedForgeUrl } from "../forges/url.js";
import type { ResolvedReviewProvider } from "../providers/resolve.js";
import {
  BasePolicyBindingError,
  bindBasePolicy,
  type BasePolicyBinding,
} from "../review/base-policy.js";
import type { ReviewRunResult } from "../review/orchestrator.js";
import {
  runAuthorizedChecks,
  RunChecksError,
  type RunCheckCommand,
} from "../review/run-checks.js";
import type { ReviewCommandOptions, ReviewCommandResult } from "./review.js";

type ProviderResolution =
  | { readonly ok: true; readonly value: ResolvedReviewProvider }
  | { readonly ok: false; readonly result: ReviewCommandResult };

interface ForgeReviewExecutionRequest {
  readonly command: ReviewCommandOptions;
  readonly input: ImmutableReviewInput;
  readonly provider: ResolvedReviewProvider;
  readonly basePolicy: BasePolicyBinding;
  readonly checksFailed: boolean;
}

interface ForgeReviewRuntime {
  resolveProvider(options: ReviewCommandOptions): Promise<ProviderResolution>;
  executeReview(request: ForgeReviewExecutionRequest): Promise<ReviewRunResult>;
  render(
    result: ReviewRunResult,
    options: ReviewCommandOptions,
    provider: ResolvedReviewProvider,
  ): Promise<ReviewCommandResult>;
}

interface PublicationRequest {
  readonly command: ReviewCommandOptions;
  readonly parsedUrl: ParsedForgeUrl;
  readonly reader: ForgeReader;
  readonly initialRead: ForgeReadResult;
  readonly credentials: ForgeCredentials;
  readonly transport: ForgeTransport;
  readonly review: ReviewRunResult;
  readonly rendered: ReviewCommandResult;
}

function providerOptions(
  options: ReviewCommandOptions,
  policy: BasePolicyBinding,
): ReviewCommandOptions {
  return {
    ...options,
    ...(policy.providerName === undefined
      ? {}
      : { providerName: policy.providerName }),
    ...(policy.model === undefined ? {} : { model: policy.model }),
  };
}

function providerPolicyMismatch(
  provider: ResolvedReviewProvider,
  policy: BasePolicyBinding,
): ReviewCommandResult | undefined {
  if (
    policy.providerName !== undefined &&
    provider.providerName !== policy.providerName
  ) {
    return {
      exitCode: 2,
      output:
        "Selected Provider does not match the authoritative base policy\n",
    };
  }
  if (policy.model !== undefined && provider.model !== policy.model) {
    return {
      exitCode: 2,
      output: "Selected model does not match the authoritative base policy\n",
    };
  }
  return undefined;
}

function addBasePolicyNotes(
  rendered: ReviewCommandResult,
  policy: BasePolicyBinding,
): ReviewCommandResult {
  const notes = [
    `Base-policy: bound to ${policy.baseSha.slice(0, 12)} (head ${policy.headSha.slice(0, 12)} not authoritative)`,
    ...(policy.headPolicyPathsIgnored.length === 0
      ? []
      : [
          `Ignored head policy paths: ${policy.headPolicyPathsIgnored.join(", ")}`,
        ]),
    ...policy.diagnostics.slice(0, 8),
  ];
  return { ...rendered, output: `${notes.join("\n")}\n${rendered.output}` };
}

function basePolicyCheckCommands(
  policy: BasePolicyBinding,
  cwd: string,
): readonly RunCheckCommand[] {
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

async function runBasePolicyChecks(options: {
  readonly command: ReviewCommandOptions;
  readonly policy: BasePolicyBinding;
  readonly cwd: string;
}): Promise<
  | { readonly kind: "continue"; readonly failed: boolean }
  | { readonly kind: "result"; readonly result: ReviewCommandResult }
> {
  if (options.command.runChecks !== true) {
    return { kind: "continue", failed: false };
  }
  const commands = basePolicyCheckCommands(options.policy, options.cwd);
  if (commands.length === 0) {
    return {
      kind: "result",
      result: {
        exitCode: 2,
        output: "The authoritative base policy defines no qualityCommands\n",
      },
    };
  }
  const checks = await runAuthorizedChecks({
    authorized: true,
    commands,
    previewOnly: options.command.runChecksPreviewOnly === true,
    ...(options.command.signal === undefined
      ? {}
      : { signal: options.command.signal }),
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
    kind: "continue",
    failed:
      checks.results?.some(
        (item) => item.timedOut || item.truncated || item.exitCode !== 0,
      ) === true,
  };
}

async function publishReviewedChange(
  request: PublicationRequest,
): Promise<ReviewCommandResult> {
  if (request.command.publish !== true) return request.rendered;
  if (request.command.yes !== true) {
    return {
      exitCode: 2,
      output:
        "Publication requires independent confirmation with --publish --yes\n",
    };
  }
  if (request.review.incomplete || request.review.scoreGate === "INCOMPLETE") {
    return {
      exitCode: 4,
      output: "Publication refused because the review is incomplete\n",
    };
  }

  const fresh = await request.reader.read(
    request.parsedUrl,
    request.credentials,
    request.transport,
  );
  if (fresh.metadata.headSha !== request.initialRead.metadata.headSha) {
    return {
      exitCode: 4,
      output: "Publication refused because the forge head SHA changed\n",
    };
  }
  const target: PublicationTarget = {
    forge: request.parsedUrl.kind,
    repository: `${request.parsedUrl.owner}/${request.parsedUrl.repository}`,
    number: request.parsedUrl.number,
    headSha: request.initialRead.metadata.headSha,
    reportHash: request.review.reportHash,
  };
  const publication = await publishReviewComment({
    url: request.parsedUrl,
    target,
    reportText: request.rendered.output,
    credentials: request.credentials,
    transport: request.transport,
    currentHeadSha: fresh.metadata.headSha,
  });
  return {
    ...request.rendered,
    output: `${request.rendered.output}Published (${publication.action}) id=${publication.targetId}\n`,
  };
}

function forgeFailure(error: unknown): ReviewCommandResult {
  if (error instanceof EgressError) {
    return { exitCode: 2, output: `${error.message}\n` };
  }
  if (
    error instanceof ForgeMaterializeError ||
    error instanceof BasePolicyBindingError
  ) {
    return {
      exitCode: 3,
      output: `Gate: INCOMPLETE\n${error.message}\n`,
    };
  }
  if (error instanceof PublicationError) {
    return { exitCode: 4, output: `${error.message}\n` };
  }
  if (error instanceof RunChecksError) {
    return { exitCode: 2, output: `${error.message}\n` };
  }
  return {
    exitCode: 3,
    output: "Gate: INCOMPLETE\nForge review failed before completion\n",
  };
}

export async function runForgeReview(
  options: ReviewCommandOptions,
  runtime: ForgeReviewRuntime,
): Promise<ReviewCommandResult> {
  if (options.forgeUrl === undefined) {
    return { exitCode: 2, output: "A Forge URL is required\n" };
  }
  const parsedUrl = parseForgeUrl(options.forgeUrl);
  const reader: ForgeReader =
    parsedUrl.kind === "github"
      ? new GitHubForgeReader()
      : new GitLabForgeReader();
  const transport =
    options.forgeTransport ??
    ({ fetch: globalThis.fetch.bind(globalThis) } satisfies ForgeTransport);
  const credentials = resolveForgeCredentials(
    options.publishTokenEnv ?? "CQ_FORGE_TOKEN",
  );
  let materialization: MaterializedForgeCheckout | null = null;

  try {
    const initialRead = await reader.read(parsedUrl, credentials, transport);
    materialization = await materializeForgeChange({
      url: parsedUrl,
      baseSha: initialRead.metadata.baseSha,
      headSha: initialRead.metadata.headSha,
      ...(initialRead.metadata.cloneUrl === undefined
        ? {}
        : { cloneUrl: initialRead.metadata.cloneUrl }),
      ...(initialRead.metadata.headCloneUrl === undefined
        ? {}
        : { headCloneUrl: initialRead.metadata.headCloneUrl }),
      credentials,
    });
    const basePolicy = await bindBasePolicy({
      baseWorktree: materialization.baseWorktree,
      headWorktree: materialization.headWorktree,
      baseSha: materialization.baseSha,
      headSha: materialization.headSha,
      ...(options.configPath === undefined
        ? {}
        : { configPath: options.configPath }),
    });
    if (
      options.policyHash !== undefined &&
      options.policyHash !== basePolicy.policyHash
    ) {
      return {
        exitCode: 2,
        output:
          "Policy hash override does not match the authoritative base policy\n",
      };
    }

    const checks = await runBasePolicyChecks({
      command: options,
      policy: basePolicy,
      cwd: materialization.headWorktree,
    });
    if (checks.kind === "result") return checks.result;

    const resolution = await runtime.resolveProvider(
      providerOptions(options, basePolicy),
    );
    if (!resolution.ok) return resolution.result;
    const mismatch = providerPolicyMismatch(resolution.value, basePolicy);
    if (mismatch !== undefined) return mismatch;

    const review = await runtime.executeReview({
      command: options,
      input: materialization.reviewInput,
      provider: resolution.value,
      basePolicy,
      checksFailed: checks.failed,
    });
    const rendered = addBasePolicyNotes(
      await runtime.render(review, options, resolution.value),
      basePolicy,
    );
    return await publishReviewedChange({
      command: options,
      parsedUrl,
      reader,
      initialRead,
      credentials,
      transport,
      review,
      rendered,
    });
  } catch (error) {
    return forgeFailure(error);
  } finally {
    await materialization?.dispose();
  }
}
