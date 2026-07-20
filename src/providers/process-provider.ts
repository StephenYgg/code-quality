import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BoundedChildError, runBoundedChild } from "./bounded-child-process.js";
import {
  type BoundedOutputChannel,
  createBoundedOutputChannel,
} from "./bounded-output-channel.js";
import {
  assertAbsoluteExecutable,
  type ProcessProviderConfig,
  type ProviderDiagnostic,
  type ProviderReviewRequest,
  type ProviderReviewResponse,
  ProviderError,
  redactSecrets,
  type ReviewProvider,
  validateModelAllowlist,
} from "./provider.js";
import {
  type PreparedProviderSchema,
  prepareProviderResponseSchema,
} from "./response-validator.js";
import {
  createExecutableSnapshot,
  type ExecutableSnapshot,
} from "./executable-snapshot.js";
import {
  ProcessProviderSessionManager,
  type ProcessSessionResource,
} from "./process-provider-session.js";
import type {
  ReviewProviderSession,
  ReviewProviderSessionOptions,
} from "./provider.js";

export interface ProcessProviderOutput {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly lastMessage: Buffer;
}

interface ProcessAttemptContext {
  readonly request: ProviderReviewRequest;
  readonly workspace: string;
  readonly schemaPath: string;
  readonly outputPath: string;
  readonly deadline: number;
  readonly preparedSchema: PreparedProviderSchema;
  readonly executable: string;
  readonly environment: NodeJS.ProcessEnv;
}

interface ProviderSessionResource extends ProcessSessionResource {
  readonly snapshot: ExecutableSnapshot;
  readonly environment: NodeJS.ProcessEnv;
}

function boundedLastMessagePath(): string | undefined {
  if (process.platform === "darwin") return "/dev/fd/3";
  if (process.platform === "linux") return "/proc/self/fd/3";
  return undefined;
}

async function outputChannelFor(
  options: Parameters<typeof runProcess>[0],
): Promise<BoundedOutputChannel | undefined> {
  if (!options.captureLastMessage) return undefined;
  return createBoundedOutputChannel({
    workspace: options.cwd,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

async function executeProviderChild(
  options: Parameters<typeof runProcess>[0],
  outputChannel: BoundedOutputChannel | undefined,
  timeoutMs: number,
): Promise<ProcessProviderOutput> {
  const childOptions = {
    executable: options.executable,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    timeoutMs,
    maxStdoutBytes: options.maxStdoutBytes,
    maxStderrBytes: options.maxStderrBytes,
    signal: options.signal,
    ...(outputChannel === undefined
      ? {}
      : {
          extraOutput: {
            childFd: outputChannel.childFd,
            stream: outputChannel.stream,
            maxBytes: options.maxStdoutBytes,
          },
        }),
  };
  const execution = runBoundedChild(childOptions);
  void execution.catch(() => undefined);
  await outputChannel?.closeParentWriter();
  const result = await execution;
  if (result.exitCode !== 0) {
    throw new ProviderError(
      "PROVIDER_FAILED",
      "Provider process exited with a non-zero status",
    );
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    lastMessage: result.extraOutput,
  };
}

function translateProcessError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (!(error instanceof BoundedChildError)) {
    return new ProviderError("PROVIDER_FAILED", "Provider process failed");
  }
  if (error.reason === "aborted") {
    return new ProviderError("PROVIDER_ABORTED", "Provider call was cancelled");
  }
  if (error.reason === "timeout") {
    return new ProviderError("PROVIDER_TIMEOUT", "Provider call timed out");
  }
  const outputLimitReasons = new Set([
    "stdout_limit",
    "stderr_limit",
    "combined_limit",
    "extra_output_limit",
  ]);
  if (outputLimitReasons.has(error.reason)) {
    return new ProviderError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      "Provider process output exceeded its hard limit",
    );
  }
  return new ProviderError("PROVIDER_FAILED", "Provider process failed");
}

async function runProcess(options: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly signal: AbortSignal;
  readonly captureLastMessage: boolean;
}): Promise<ProcessProviderOutput> {
  let outputChannel: BoundedOutputChannel | undefined;
  const deadline = Date.now() + options.timeoutMs;
  try {
    outputChannel = await outputChannelFor(options);
    const childTimeoutMs = deadline - Date.now();
    if (childTimeoutMs <= 0) {
      throw new ProviderError("PROVIDER_TIMEOUT", "Provider call timed out");
    }
    return await executeProviderChild(options, outputChannel, childTimeoutMs);
  } catch (error) {
    throw translateProcessError(error);
  } finally {
    await outputChannel?.dispose();
  }
}

function baseProviderEnvironment(
  workspace: string,
  captured: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    PATH: captured.PATH ?? "",
    LANG: "C",
    LC_ALL: "C",
    HOME: workspace,
    ...captured,
  };
}

function assertRequestBound(
  payload: string,
  schema: string,
  maxBytes: number,
): void {
  const bytes =
    Buffer.byteLength(payload, "utf8") + Buffer.byteLength(schema, "utf8");
  if (bytes > maxBytes) {
    throw new ProviderError(
      "PROVIDER_RESPONSE_TOO_LARGE",
      "Provider request exceeded its hard limit",
    );
  }
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new ProviderError("PROVIDER_TIMEOUT", "Provider call timed out");
  }
  return remaining;
}

function repairPayload(payload: string, error: ProviderError): string {
  return [
    payload,
    "",
    `The previous response failed validation: ${error.message}`,
    "Return only valid JSON matching the supplied schema.",
  ].join("\n");
}

function serializeReviewRequest(request: ProviderReviewRequest): string {
  return JSON.stringify({
    runId: request.runId,
    stageId: request.stageId,
    model: request.model,
    systemInstructions: request.systemInstructions,
    untrustedContext: request.untrustedContext,
    maxOutputTokens: request.maxOutputTokens,
  });
}

export abstract class ProcessReviewProvider implements ReviewProvider {
  private readonly sessions: ProcessProviderSessionManager<ProviderSessionResource>;
  private readonly activeSecrets = new Map<string, number>();

  protected constructor(protected readonly config: ProcessProviderConfig) {
    this.sessions = new ProcessProviderSessionManager((options) =>
      this.createSessionResource(options),
    );
  }

  abstract capabilities(): ReturnType<ReviewProvider["capabilities"]>;
  protected abstract buildArguments(
    request: ProviderReviewRequest,
    workspace: string,
    schemaPath: string,
    schemaJson: string,
    outputPath: string,
  ): readonly string[];
  protected abstract parseResponse(
    output: ProcessProviderOutput,
    request: ProviderReviewRequest,
  ): ProviderReviewResponse;

  protected abstract requiredProbeFlags(): readonly string[];

  protected captureSessionEnvironment(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH ?? "" };
  }

  protected processEnvironment(
    workspace: string,
    captured: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv {
    return baseProviderEnvironment(workspace, captured);
  }

  protected capturesLastMessageOutput(): boolean {
    return false;
  }

  protected credentialSecrets(): readonly string[] {
    return [];
  }

  async validateConfiguration(): Promise<readonly ProviderDiagnostic[]> {
    const diagnostics = await this.configurationDiagnostics();
    if (diagnostics.length > 0) return diagnostics;
    const controller = new AbortController();
    const deadline = Date.now() + 3_000;
    let snapshot: ExecutableSnapshot | undefined;
    try {
      snapshot = await createExecutableSnapshot({
        kind: this.config.kind,
        executable: this.config.executable,
        signal: controller.signal,
        deadline,
      });
      return await this.probeConfiguration(snapshot.path, {
        signal: controller.signal,
        deadline,
      });
    } catch (error) {
      return [this.configurationErrorDiagnostic(error)];
    } finally {
      await snapshot?.release();
    }
  }

  private async configurationDiagnostics(): Promise<ProviderDiagnostic[]> {
    const diagnostics = [
      ...assertAbsoluteExecutable(this.config.executable),
      ...validateModelAllowlist(this.config.model, this.config.allowedModels),
    ];
    if (
      this.capturesLastMessageOutput() &&
      boundedLastMessagePath() === undefined
    ) {
      diagnostics.push({
        code: "PROVIDER_OUTPUT_BOUND_UNSUPPORTED",
        message:
          "Provider last-message output cannot be bounded on this platform",
        path: "/executable",
      });
    }
    try {
      await access(this.config.executable);
    } catch {
      diagnostics.push({
        code: "PROVIDER_EXECUTABLE_MISSING",
        message: "Provider executable is not accessible",
        path: "/executable",
      });
    }
    return diagnostics;
  }

  private async probeConfiguration(
    executable: string,
    options: { readonly signal: AbortSignal; readonly deadline: number },
  ): Promise<readonly ProviderDiagnostic[]> {
    const { probeProcessProviderResult } = await import("./probe.js");
    const probe = await probeProcessProviderResult({
      kind: this.config.kind,
      executable,
      requiredFlags: this.requiredProbeFlags(),
      signal: options.signal,
      deadline: options.deadline,
    });
    if (probe.terminal === "aborted") {
      throw new ProviderError(
        "PROVIDER_ABORTED",
        "Provider call was cancelled",
      );
    }
    if (probe.terminal === "timeout") {
      throw new ProviderError("PROVIDER_TIMEOUT", "Provider call timed out");
    }
    return probe.diagnostics;
  }

  private configurationErrorDiagnostic(error: unknown): ProviderDiagnostic {
    const providerError =
      error instanceof ProviderError
        ? error
        : new ProviderError(
            "PROVIDER_UNSAFE",
            "Provider executable validation failed",
          );
    const code =
      providerError.code === "PROVIDER_ABORTED"
        ? "PROVIDER_PROBE_ABORTED"
        : providerError.code === "PROVIDER_TIMEOUT"
          ? "PROVIDER_PROBE_TIMEOUT"
          : providerError.code === "PROVIDER_CAPACITY"
            ? "PROVIDER_SNAPSHOT_CAPACITY"
            : "PROVIDER_EXECUTABLE_INVALID";
    return { code, message: providerError.message, path: "/executable" };
  }

  private async createSessionResource(
    options: ReviewProviderSessionOptions,
  ): Promise<ProviderSessionResource> {
    const diagnostics = await this.configurationDiagnostics();
    if (diagnostics.length > 0) {
      throw new ProviderError(
        "PROVIDER_CONFIG_INVALID",
        diagnostics[0]?.message ?? "Provider configuration is invalid",
      );
    }
    const environment = Object.freeze({ ...this.captureSessionEnvironment() });
    const secrets = Object.freeze([...this.credentialSecrets()]);
    const snapshot = await createExecutableSnapshot({
      kind: this.config.kind,
      executable: this.config.executable,
      signal: options.signal,
      deadline: options.deadline,
    });
    try {
      const probe = await this.probeConfiguration(snapshot.path, options);
      if (probe.length > 0) {
        throw new ProviderError(
          "PROVIDER_CONFIG_INVALID",
          probe[0]?.message ?? "Provider configuration is invalid",
        );
      }
      this.addActiveSecrets(secrets);
      let cleanupComplete = false;
      let releaseAttempt: Promise<void> | undefined;
      return Object.freeze({
        snapshot,
        environment,
        release: async (): Promise<void> => {
          if (cleanupComplete) return;
          if (releaseAttempt !== undefined) return releaseAttempt;
          releaseAttempt = (async () => {
            await snapshot.release();
            this.removeActiveSecrets(secrets);
            cleanupComplete = true;
          })();
          try {
            await releaseAttempt;
          } finally {
            releaseAttempt = undefined;
          }
        },
      });
    } catch (error) {
      await snapshot.release();
      throw error;
    }
  }

  async openReviewSession(
    options: ReviewProviderSessionOptions,
  ): Promise<ReviewProviderSession> {
    return this.sessions.acquire(options);
  }

  async review(
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse> {
    const deadline = Date.now() + request.timeoutMs;
    if (request.attemptBudget.used >= request.attemptBudget.maxAttempts) {
      throw new ProviderError(
        "PROVIDER_FAILED",
        "Provider attempt budget is exhausted",
      );
    }
    const lease = await this.sessions.acquire({
      runId: request.runId,
      signal: request.signal,
      deadline,
    });
    let workspace: string | undefined;
    try {
      workspace = await mkdtemp(join(tmpdir(), ".cq-provider-"));
      const schemaPath = join(workspace, "schema.json");
      const outputPath = this.capturesLastMessageOutput()
        ? boundedLastMessagePath()
        : join(workspace, "unused-last-message.json");
      if (outputPath === undefined) {
        throw new ProviderError(
          "PROVIDER_UNSAFE",
          "Provider last-message output cannot be bounded on this platform",
        );
      }
      const preparedSchema = prepareProviderResponseSchema(
        request.outputSchema,
        request.maxRequestBytes,
      );
      const payload = serializeReviewRequest(request);
      assertRequestBound(payload, preparedSchema.json, request.maxRequestBytes);
      await writeFile(schemaPath, `${preparedSchema.json}\n`, {
        mode: 0o600,
      });
      const context = {
        request,
        workspace,
        schemaPath,
        outputPath,
        deadline,
        preparedSchema,
        executable: lease.resource.snapshot.path,
        environment: this.processEnvironment(
          workspace,
          lease.resource.environment,
        ),
      } satisfies ProcessAttemptContext;
      const result = await this.runAttempt(context, payload);
      return await this.parseWithRepair(context, payload, result);
    } finally {
      try {
        if (workspace !== undefined) {
          await rm(workspace, { force: true, recursive: true });
        }
      } finally {
        await lease.release();
      }
    }
  }

  private async runAttempt(
    context: ProcessAttemptContext,
    stdin: string,
  ): Promise<ProcessProviderOutput> {
    const { request } = context;
    assertRequestBound(
      stdin,
      context.preparedSchema.json,
      request.maxRequestBytes,
    );
    return runProcess({
      executable: context.executable,
      args: this.buildArguments(
        request,
        context.workspace,
        context.schemaPath,
        context.preparedSchema.json,
        context.outputPath,
      ),
      cwd: context.workspace,
      env: context.environment,
      stdin,
      timeoutMs: remainingTimeout(context.deadline),
      maxStdoutBytes: request.maxResponseBytes,
      maxStderrBytes: request.maxDiagnosticBytes,
      signal: request.signal,
      captureLastMessage: this.capturesLastMessageOutput(),
    });
  }

  private async parseWithRepair(
    context: ProcessAttemptContext,
    payload: string,
    result: ProcessProviderOutput,
  ): Promise<ProviderReviewResponse> {
    try {
      const response = this.parseResponse(result, context.request);
      context.preparedSchema.validator.assertValid(response.content);
      return response;
    } catch (error) {
      const { attemptBudget } = context.request;
      const canRepair = attemptBudget.used + 1 < attemptBudget.maxAttempts;
      if (
        !(error instanceof ProviderError) ||
        error.code !== "PROVIDER_RESPONSE_INVALID" ||
        !canRepair
      ) {
        throw error;
      }
      const repaired = await this.runAttempt(
        context,
        repairPayload(payload, error),
      );
      const response = this.parseResponse(repaired, context.request);
      context.preparedSchema.validator.assertValid(response.content);
      return { ...response, attemptsUsed: 2 };
    }
  }

  redactDiagnostic(value: unknown): string {
    return redactSecrets(value, [
      ...this.credentialSecrets(),
      ...this.activeSecrets.keys(),
    ]);
  }

  private addActiveSecrets(secrets: readonly string[]): void {
    for (const secret of secrets) {
      this.activeSecrets.set(secret, (this.activeSecrets.get(secret) ?? 0) + 1);
    }
  }

  private removeActiveSecrets(secrets: readonly string[]): void {
    for (const secret of secrets) {
      const refs = this.activeSecrets.get(secret) ?? 0;
      if (refs <= 1) this.activeSecrets.delete(secret);
      else this.activeSecrets.set(secret, refs - 1);
    }
  }
}
