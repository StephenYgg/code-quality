import { spawn, type ChildProcessByStdio } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

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

type StdioChild = ChildProcessByStdio<Writable, Readable, Readable>;

function terminate(child: StdioChild): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // close remains the completion signal
  }
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, 100).unref();
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
}): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }> {
  if (options.signal.aborted) {
    throw new ProviderError("PROVIDER_ABORTED", "Provider call was cancelled");
  }
  return new Promise((resolve, reject) => {
    let child: StdioChild;
    try {
      child = spawn(options.executable, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(
        new ProviderError(
          "PROVIDER_FAILED",
          "Provider process could not start",
        ),
      );
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminal: ProviderError | undefined;

    const finish = (error?: ProviderError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        terminate(child);
        reject(error);
      }
    };

    const onAbort = () => {
      terminal = new ProviderError(
        "PROVIDER_ABORTED",
        "Provider call was cancelled",
      );
      finish(terminal);
    };
    const timeout = setTimeout(() => {
      terminal = new ProviderError(
        "PROVIDER_TIMEOUT",
        "Provider call timed out",
      );
      finish(terminal);
    }, options.timeoutMs);
    timeout.unref();
    options.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes) {
        finish(
          new ProviderError(
            "PROVIDER_RESPONSE_TOO_LARGE",
            "Provider stdout exceeded its hard limit",
          ),
        );
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxStderrBytes) {
        finish(
          new ProviderError(
            "PROVIDER_RESPONSE_TOO_LARGE",
            "Provider stderr exceeded its hard limit",
          ),
        );
        return;
      }
      stderr.push(Buffer.from(chunk));
    });
    child.once("error", () => {
      finish(
        new ProviderError(
          "PROVIDER_FAILED",
          "Provider process failed to spawn",
        ),
      );
    });
    child.once("close", (code) => {
      if (settled && terminal !== undefined) {
        reject(terminal);
        return;
      }
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
      if (code !== 0) {
        reject(
          new ProviderError(
            "PROVIDER_FAILED",
            "Provider process exited with a non-zero status",
          ),
        );
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
      });
    });

    child.stdin.end(options.stdin, "utf8");
  });
}

export abstract class ProcessReviewProvider implements ReviewProvider {
  protected constructor(protected readonly config: ProcessProviderConfig) {}

  abstract capabilities(): ReturnType<ReviewProvider["capabilities"]>;
  protected abstract buildArguments(
    request: ProviderReviewRequest,
    workspace: string,
    schemaPath: string,
  ): readonly string[];
  protected abstract parseResponse(
    stdout: Buffer,
    request: ProviderReviewRequest,
  ): ProviderReviewResponse;

  async validateConfiguration(): Promise<readonly ProviderDiagnostic[]> {
    const diagnostics = [
      ...assertAbsoluteExecutable(this.config.executable),
      ...validateModelAllowlist(this.config.model, this.config.allowedModels),
    ];
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

  async review(
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse> {
    const diagnostics = await this.validateConfiguration();
    if (diagnostics.length > 0) {
      throw new ProviderError(
        "PROVIDER_CONFIG_INVALID",
        diagnostics[0]?.message ?? "Provider configuration is invalid",
      );
    }
    const workspace = await mkdtemp(join(tmpdir(), ".cq-provider-"));
    const schemaPath = join(workspace, "schema.json");
    try {
      await writeFile(schemaPath, `${JSON.stringify(request.outputSchema)}\n`, {
        mode: 0o600,
      });
      const payload = JSON.stringify({
        runId: request.runId,
        stageId: request.stageId,
        model: request.model,
        systemInstructions: request.systemInstructions,
        untrustedContext: request.untrustedContext,
        maxOutputTokens: request.maxOutputTokens,
      });
      if (Buffer.byteLength(payload, "utf8") > request.maxRequestBytes) {
        throw new ProviderError(
          "PROVIDER_RESPONSE_TOO_LARGE",
          "Provider request exceeded its hard limit",
        );
      }
      const result = await runProcess({
        executable: this.config.executable,
        args: this.buildArguments(request, workspace, schemaPath),
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? "",
          LANG: "C",
          LC_ALL: "C",
          HOME: workspace,
        },
        stdin: payload,
        timeoutMs: request.timeoutMs,
        maxStdoutBytes: request.maxResponseBytes,
        maxStderrBytes: request.maxDiagnosticBytes,
        signal: request.signal,
      });
      try {
        return this.parseResponse(result.stdout, request);
      } catch (error) {
        if (
          request.attemptBudget.maxAttempts === 2 &&
          request.attemptBudget.used < 1
        ) {
          const repaired = await runProcess({
            executable: this.config.executable,
            args: this.buildArguments(request, workspace, schemaPath),
            cwd: workspace,
            env: {
              PATH: process.env.PATH ?? "",
              LANG: "C",
              LC_ALL: "C",
              HOME: workspace,
            },
            stdin: `${payload}\nREPAIR: return valid JSON matching the schema`,
            timeoutMs: Math.max(1, Math.floor(request.timeoutMs / 2)),
            maxStdoutBytes: request.maxResponseBytes,
            maxStderrBytes: request.maxDiagnosticBytes,
            signal: request.signal,
          });
          const response = this.parseResponse(repaired.stdout, request);
          return { ...response, attemptsUsed: 2 };
        }
        throw error;
      }
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  }

  redactDiagnostic(value: unknown): string {
    return redactSecrets(value, []);
  }
}
