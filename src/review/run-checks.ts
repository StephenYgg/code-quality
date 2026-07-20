import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";

import {
  BoundedChildError,
  type BoundedChildFailureReason,
  runBoundedChild,
} from "../providers/bounded-child-process.js";

const MAX_CHECK_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_CHECK_TIMEOUT_MS = 300_000;
const MAX_PATH_ENTRIES = 64;
const MAX_PATH_BYTES = 16 * 1024;

export interface RunCheckCommand {
  readonly label: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

export interface RunCheckResult {
  readonly label: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly failureReason?: BoundedChildFailureReason | "total_timeout";
}

export class RunChecksError extends Error {
  constructor(
    readonly code:
      "RUN_CHECKS_ABORTED" | "RUN_CHECKS_UNAUTHORIZED" | "RUN_CHECKS_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "RunChecksError";
  }
}

function sanitizedEnv(path: string): NodeJS.ProcessEnv {
  return {
    PATH: path,
    LANG: "C",
    LC_ALL: "C",
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    ...(process.platform === "win32" && process.env.SystemRoot !== undefined
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
}

export function validateCheckCommand(command: RunCheckCommand): void {
  if (command.argv.length === 0 || command.argv.length > 64) {
    throw new RunChecksError(
      "RUN_CHECKS_INVALID",
      "Check command argv bounds are invalid",
    );
  }
  if (command.argv.some((part) => part.includes("\0"))) {
    throw new RunChecksError(
      "RUN_CHECKS_INVALID",
      "Check command argv contains NUL",
    );
  }
  if (
    command.label.length === 0 ||
    command.label.length > 128 ||
    command.argv.reduce(
      (bytes, part) => bytes + Buffer.byteLength(part, "utf8"),
      0,
    ) >
      64 * 1024
  ) {
    throw new RunChecksError(
      "RUN_CHECKS_INVALID",
      "Check label or argv bytes are invalid",
    );
  }
  const executable = command.argv[0] ?? "";
  if (
    !isAbsolute(executable) &&
    (executable.includes("/") || executable.includes("\\"))
  ) {
    throw new RunChecksError(
      "RUN_CHECKS_INVALID",
      "Check executable must be an absolute path or a bare trusted PATH name",
    );
  }
  if (!isAbsolute(command.cwd)) {
    throw new RunChecksError(
      "RUN_CHECKS_INVALID",
      "Check command cwd must be absolute",
    );
  }
  if (
    !Number.isSafeInteger(command.timeoutMs) ||
    command.timeoutMs < 1 ||
    command.timeoutMs > 120_000
  ) {
    throw new RunChecksError(
      "RUN_CHECKS_INVALID",
      "Check command timeout is outside its hard limit",
    );
  }
  if (
    !Number.isSafeInteger(command.maxStdoutBytes) ||
    command.maxStdoutBytes < 1 ||
    command.maxStdoutBytes > MAX_CHECK_OUTPUT_BYTES ||
    !Number.isSafeInteger(command.maxStderrBytes) ||
    command.maxStderrBytes < 1 ||
    command.maxStderrBytes > MAX_CHECK_OUTPUT_BYTES
  ) {
    throw new RunChecksError(
      "RUN_CHECKS_INVALID",
      "Check output bounds are outside their hard limits",
    );
  }
}

export async function runAuthorizedChecks(options: {
  readonly authorized: boolean;
  readonly commands: readonly RunCheckCommand[];
  readonly previewOnly?: boolean;
  readonly totalTimeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<
  | { readonly preview: string; readonly results?: undefined }
  | { readonly preview: string; readonly results: readonly RunCheckResult[] }
> {
  if (!options.authorized) {
    throw new RunChecksError(
      "RUN_CHECKS_UNAUTHORIZED",
      "Run-checks requires explicit authorization",
    );
  }
  if (options.commands.length === 0 || options.commands.length > 16) {
    throw new RunChecksError(
      "RUN_CHECKS_INVALID",
      "Run-checks command count is outside its hard limit",
    );
  }
  for (const command of options.commands) validateCheckCommand(command);
  const totalTimeoutMs =
    options.totalTimeoutMs ??
    Math.min(
      MAX_TOTAL_CHECK_TIMEOUT_MS,
      options.commands.reduce((total, command) => total + command.timeoutMs, 0),
    );
  if (
    !Number.isSafeInteger(totalTimeoutMs) ||
    totalTimeoutMs < 1 ||
    totalTimeoutMs > MAX_TOTAL_CHECK_TIMEOUT_MS
  ) {
    throw new RunChecksError(
      "RUN_CHECKS_INVALID",
      "Run-checks total timeout is outside its hard limit",
    );
  }
  const preview = options.commands
    .map(
      (command) =>
        `- ${command.label}: ${command.argv.map((part) => JSON.stringify(part)).join(" ")} (cwd=${command.cwd})`,
    )
    .join("\n");
  if (options.previewOnly === true) {
    return { preview };
  }
  throwIfAborted(options.signal);
  const results: RunCheckResult[] = [];
  const deadline = Date.now() + totalTimeoutMs;
  for (const command of options.commands) {
    throwIfAborted(options.signal);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      results.push(failedResult(command.label, "total_timeout"));
      continue;
    }
    results.push(
      await runOne(
        command,
        Math.min(command.timeoutMs, remainingMs),
        options.signal,
      ),
    );
  }
  return { preview, results: Object.freeze(results) };
}

async function runOne(
  command: RunCheckCommand,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<RunCheckResult> {
  const environment = await trustedEnvironment(command.cwd);
  const executable = await resolveExecutable(
    command.argv[0] ?? "",
    environment,
  );
  if (executable === undefined) return failedResult(command.label, "spawn");
  const localController = new AbortController();
  const abort = (): void => {
    localController.abort(signal?.reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted === true) abort();
  try {
    const result = await runBoundedChild({
      executable,
      args: command.argv.slice(1),
      cwd: command.cwd,
      env: sanitizedEnv(environment.path),
      timeoutMs,
      maxStdoutBytes: command.maxStdoutBytes,
      maxStderrBytes: command.maxStderrBytes,
      signal: localController.signal,
    });
    return {
      label: command.label,
      exitCode: result.exitCode,
      timedOut: false,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
      truncated: false,
    };
  } catch (error) {
    if (
      signal?.aborted === true ||
      (error instanceof BoundedChildError && error.reason === "aborted")
    ) {
      throw new RunChecksError(
        "RUN_CHECKS_ABORTED",
        "Run-checks was cancelled",
      );
    }
    return failedResult(
      command.label,
      error instanceof BoundedChildError ? error.reason : "supervisor",
      command,
    );
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function failedResult(
  label: string,
  reason: BoundedChildFailureReason | "total_timeout",
  command?: RunCheckCommand,
): RunCheckResult {
  const stdoutLimit = reason === "stdout_limit" || reason === "combined_limit";
  const stderrLimit = reason === "stderr_limit" || reason === "combined_limit";
  return {
    label,
    exitCode: null,
    timedOut: reason === "timeout" || reason === "total_timeout",
    stdoutBytes: stdoutLimit ? (command?.maxStdoutBytes ?? 0) + 1 : 0,
    stderrBytes: stderrLimit ? (command?.maxStderrBytes ?? 0) + 1 : 0,
    truncated: stdoutLimit || stderrLimit || reason === "extra_output_limit",
    failureReason: reason,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw new RunChecksError("RUN_CHECKS_ABORTED", "Run-checks was cancelled");
}

interface TrustedEnvironment {
  readonly path: string;
  readonly directories: readonly string[];
}

async function trustedEnvironment(cwd: string): Promise<TrustedEnvironment> {
  const directories: string[] = [];
  let bytes = 0;
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry.length === 0 || directories.length >= MAX_PATH_ENTRIES) continue;
    bytes += Buffer.byteLength(entry, "utf8");
    if (bytes > MAX_PATH_BYTES) break;
    let resolved: string;
    try {
      resolved = await realpath(entry);
    } catch {
      continue;
    }
    if (!isContained(cwd, resolved) && !directories.includes(resolved)) {
      directories.push(resolved);
    }
  }
  return { path: directories.join(delimiter), directories };
}

async function resolveExecutable(
  configured: string,
  environment: TrustedEnvironment,
): Promise<string | undefined> {
  const candidates = isAbsolute(configured)
    ? [configured]
    : environment.directories.map((directory) => join(directory, configured));
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const metadata = await stat(resolved);
      await access(resolved, constants.X_OK);
      if (metadata.isFile()) return resolved;
    } catch {
      // Try the next trusted PATH entry.
    }
  }
  return undefined;
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) &&
      relation !== ".." &&
      !relation.startsWith(`..${sep}`))
  );
}
