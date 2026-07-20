import { spawn, type ChildProcessByStdio } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { devNull } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
export const DEFAULT_GIT_STDOUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_GIT_STDERR_BYTES = 64 * 1024;
export const MAX_GIT_TIMEOUT_MS = 120_000;
export const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

export type GitCommandErrorCode =
  | "GIT_ABORTED"
  | "GIT_ARGUMENT_INVALID"
  | "GIT_COMMAND_FAILED"
  | "GIT_SPAWN_FAILED"
  | "GIT_STDERR_LIMIT_EXCEEDED"
  | "GIT_STDOUT_LIMIT_EXCEEDED"
  | "GIT_TIMEOUT";

export class GitCommandError extends Error {
  readonly exitCode: number | undefined;

  constructor(
    readonly code: GitCommandErrorCode,
    message: string,
    exitCode?: number,
  ) {
    super(message);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
  }
}

export interface GitCommandRequest {
  readonly repository: string;
  readonly args: readonly string[];
  readonly executable?: string;
  readonly execution?: TrustedGitExecution | undefined;
  readonly maximumStdoutBytes?: number;
  readonly maximumStderrBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal | undefined;
  readonly gitConfig?: readonly GitConfigEntry[];
  /** Allows only fixed, read-only hooksPath queries to observe repository config. */
  readonly hooksPathQuery?: boolean;
}

export interface GitConfigEntry {
  readonly key: `http.https://${"github.com" | "gitlab.com"}/.extraHeader`;
  readonly value: string;
}

export interface GitCommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface TrustedGitExecution {
  readonly executable: string;
  readonly path: string;
}

interface CommandLimits {
  readonly maximumStdoutBytes: number;
  readonly maximumStderrBytes: number;
  readonly timeoutMs: number;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new GitCommandError(
      "GIT_ARGUMENT_INVALID",
      `${name} must be an integer from 1 to ${maximum.toString()}`,
    );
  }
  return resolved;
}

function validateRequest(request: GitCommandRequest): CommandLimits {
  if (
    request.repository.length === 0 ||
    request.args.length === 0 ||
    request.args.length > 256 ||
    request.args.some((argument) => argument.includes("\0")) ||
    request.args.reduce(
      (bytes, argument) => bytes + Buffer.byteLength(argument),
      0,
    ) >
      64 * 1024
  ) {
    throw new GitCommandError(
      "GIT_ARGUMENT_INVALID",
      "Git command arguments are invalid or exceed their hard limit",
    );
  }
  if (request.hooksPathQuery === true && !isHooksPathQuery(request.args)) {
    throw new GitCommandError(
      "GIT_ARGUMENT_INVALID",
      "Configured hooksPath may only be read by an approved query",
    );
  }
  const gitConfig = request.gitConfig ?? [];
  if (
    gitConfig.length > 4 ||
    gitConfig.some(
      (entry) =>
        !/^http\.https:\/\/(?:github\.com|gitlab\.com)\/\.extraHeader$/u.test(
          entry.key,
        ) ||
        entry.value.length === 0 ||
        entry.value.includes("\0") ||
        entry.value.includes("\r") ||
        entry.value.includes("\n") ||
        Buffer.byteLength(entry.value, "utf8") > 8 * 1024,
    )
  ) {
    throw new GitCommandError(
      "GIT_ARGUMENT_INVALID",
      "Transient Git configuration is invalid or exceeds its hard limit",
    );
  }
  return {
    maximumStdoutBytes: boundedInteger(
      request.maximumStdoutBytes,
      DEFAULT_GIT_STDOUT_BYTES,
      MAX_GIT_OUTPUT_BYTES,
      "maximumStdoutBytes",
    ),
    maximumStderrBytes: boundedInteger(
      request.maximumStderrBytes,
      DEFAULT_GIT_STDERR_BYTES,
      MAX_GIT_OUTPUT_BYTES,
      "maximumStderrBytes",
    ),
    timeoutMs: boundedInteger(
      request.timeoutMs,
      DEFAULT_GIT_TIMEOUT_MS,
      MAX_GIT_TIMEOUT_MS,
      "timeoutMs",
    ),
  };
}

function isHooksPathQuery(args: readonly string[]): boolean {
  return (
    (args.length === 3 &&
      args[0] === "config" &&
      args[1] === "--get" &&
      args[2] === "core.hooksPath") ||
    (args.length === 3 &&
      args[0] === "rev-parse" &&
      args[1] === "--git-path" &&
      args[2] === "hooks")
  );
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

const MAX_TRUSTED_PATH_ENTRIES = 64;
const MAX_TRUSTED_PATH_BYTES = 16 * 1024;

async function trustedPathDirectories(
  repository: string,
): Promise<readonly string[]> {
  let repositoryPath: string;
  try {
    repositoryPath = await realpath(repository);
  } catch {
    repositoryPath = repository;
  }
  const directories: string[] = [];
  let scanned = 0;
  let totalBytes = 0;
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    scanned += 1;
    totalBytes += Buffer.byteLength(entry, "utf8");
    if (
      scanned > MAX_TRUSTED_PATH_ENTRIES ||
      totalBytes > MAX_TRUSTED_PATH_BYTES
    ) {
      break;
    }
    try {
      const directory = await realpath(entry);
      const metadata = await stat(directory);
      const currentUser = process.getuid?.();
      const trustedOwner =
        currentUser === undefined ||
        metadata.uid === 0 ||
        metadata.uid === currentUser;
      if (
        metadata.isDirectory() &&
        trustedOwner &&
        (metadata.mode & 0o022) === 0 &&
        !isContained(repositoryPath, directory)
      ) {
        directories.push(directory);
      }
    } catch {
      // Unreadable host PATH entries are not trusted for child resolution.
    }
  }
  return [...new Set(directories)];
}

async function resolveExecutable(
  requested: string | undefined,
  repository: string,
): Promise<TrustedGitExecution> {
  let repositoryPath: string;
  try {
    repositoryPath = await realpath(repository);
  } catch {
    repositoryPath = repository;
  }
  const directories = await trustedPathDirectories(repository);
  let candidates: readonly string[] = [];
  if (requested === undefined) {
    const executableName = process.platform === "win32" ? "git.exe" : "git";
    candidates = directories.map((directory) =>
      join(directory, executableName),
    );
  } else if (isAbsolute(requested)) {
    candidates = [requested];
  }
  for (const candidate of candidates) {
    try {
      const executable = await realpath(candidate);
      await access(executable, constants.X_OK);
      // PATH-resolved Git must never live inside the reviewed repository.
      // Explicit absolute executables remain caller-owned (tests/trusted config).
      if (
        requested === undefined &&
        (isContained(repositoryPath, executable) ||
          !directories.includes(dirname(executable)))
      ) {
        continue;
      }
      return Object.freeze({
        executable,
        path: directories.join(delimiter),
      });
    } catch {
      // Continue through bounded trusted candidates before failing closed.
    }
  }
  throw new GitCommandError(
    "GIT_SPAWN_FAILED",
    "A trusted absolute Git executable could not be resolved",
  );
}

export function resolveTrustedGitExecution(
  repository: string,
): Promise<TrustedGitExecution> {
  return resolveExecutable(undefined, repository);
}

function commandEnvironment(
  path: string,
  gitConfig: readonly GitConfigEntry[],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    PAGER: "cat",
    PATH: path,
    ...(process.platform === "win32" && process.env.SystemRoot !== undefined
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
  if (gitConfig.length > 0) {
    environment.GIT_CONFIG_COUNT = String(gitConfig.length);
    gitConfig.forEach((entry, index) => {
      environment[`GIT_CONFIG_KEY_${String(index)}`] = entry.key;
      environment[`GIT_CONFIG_VALUE_${String(index)}`] = entry.value;
    });
  }
  return environment;
}

type GitChildProcess = ChildProcessByStdio<null, Readable, Readable>;

function commandArguments(request: GitCommandRequest): readonly string[] {
  const hookIsolation =
    request.hooksPathQuery === true ? [] : ["-c", `core.hooksPath=${devNull}`];
  return [
    "--no-replace-objects",
    "--no-pager",
    ...hookIsolation,
    "-c",
    "color.ui=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    "-c",
    "diff.external=",
    ...request.args,
  ];
}

function spawnGitChild(
  request: GitCommandRequest,
  execution: TrustedGitExecution,
): GitChildProcess {
  try {
    return spawn(execution.executable, commandArguments(request), {
      cwd: request.repository,
      env: commandEnvironment(execution.path, request.gitConfig ?? []),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw new GitCommandError(
      "GIT_SPAWN_FAILED",
      "Git command could not be started",
    );
  }
}

function terminateProcess(child: GitChildProcess): NodeJS.Timeout {
  try {
    child.kill("SIGTERM");
  } catch {
    // The close event remains the single completion signal.
  }
  const forceKill = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited between the timer and kill.
    }
  }, 100);
  forceKill.unref();
  return forceKill;
}

class GitProcessObserver {
  private readonly stdout: Buffer[] = [];
  private readonly stderr: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private terminalError: GitCommandError | undefined;
  private forceKill: NodeJS.Timeout | undefined;
  private timeout: NodeJS.Timeout | undefined;

  constructor(
    private readonly child: GitChildProcess,
    private readonly request: GitCommandRequest,
    private readonly limits: CommandLimits,
  ) {}

  run(): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      this.timeout = setTimeout(() => {
        this.terminate(
          new GitCommandError("GIT_TIMEOUT", "Git command timed out"),
        );
      }, this.limits.timeoutMs);
      this.timeout.unref();
      this.request.signal?.addEventListener("abort", this.onAbort, {
        once: true,
      });
      if (this.request.signal?.aborted === true) this.onAbort();
      this.child.stdout.on("data", (chunk: Buffer) => {
        this.captureStdout(chunk);
      });
      this.child.stderr.on("data", (chunk: Buffer) => {
        this.captureStderr(chunk);
      });
      this.child.once("error", this.onSpawnError);
      this.child.once("close", (code) => {
        this.complete(code, resolve, reject);
      });
    });
  }

  private readonly onAbort = (): void => {
    this.terminate(
      new GitCommandError("GIT_ABORTED", "Git command was cancelled"),
    );
  };

  private readonly onSpawnError = (): void => {
    this.terminate(
      new GitCommandError(
        "GIT_SPAWN_FAILED",
        "Git command could not be started",
      ),
    );
  };

  private terminate(error: GitCommandError): void {
    if (this.terminalError !== undefined) return;
    this.terminalError = error;
    this.forceKill = terminateProcess(this.child);
  }

  private captureStdout(chunk: Buffer): void {
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > this.limits.maximumStdoutBytes) {
      this.terminate(
        new GitCommandError(
          "GIT_STDOUT_LIMIT_EXCEEDED",
          "Git stdout exceeded its hard byte limit",
        ),
      );
      return;
    }
    this.stdout.push(Buffer.from(chunk));
  }

  private captureStderr(chunk: Buffer): void {
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > this.limits.maximumStderrBytes) {
      this.terminate(
        new GitCommandError(
          "GIT_STDERR_LIMIT_EXCEEDED",
          "Git stderr exceeded its hard byte limit",
        ),
      );
      return;
    }
    this.stderr.push(Buffer.from(chunk));
  }

  private complete(
    code: number | null,
    resolve: (result: GitCommandResult) => void,
    reject: (error: GitCommandError) => void,
  ): void {
    if (this.timeout !== undefined) clearTimeout(this.timeout);
    if (this.forceKill !== undefined) clearTimeout(this.forceKill);
    this.request.signal?.removeEventListener("abort", this.onAbort);
    if (this.terminalError !== undefined) {
      reject(this.terminalError);
      return;
    }
    if (code !== 0) {
      reject(
        new GitCommandError(
          "GIT_COMMAND_FAILED",
          "Git command failed; stderr was captured but not exposed",
          code ?? undefined,
        ),
      );
      return;
    }
    resolve({
      stdout: Buffer.concat(this.stdout, this.stdoutBytes),
      stderr: Buffer.concat(this.stderr, this.stderrBytes),
    });
  }
}

export async function runGitCommand(
  request: GitCommandRequest,
): Promise<GitCommandResult> {
  const limits = validateRequest(request);
  if (request.execution !== undefined && request.executable !== undefined) {
    throw new GitCommandError(
      "GIT_ARGUMENT_INVALID",
      "Git command cannot select two executables",
    );
  }
  if (request.signal?.aborted === true) {
    throw new GitCommandError("GIT_ABORTED", "Git command was cancelled");
  }
  let execution = request.execution;
  if (execution === undefined) {
    execution = await resolveExecutable(request.executable, request.repository);
  }
  const child = spawnGitChild(request, execution);
  return new GitProcessObserver(child, request, limits).run();
}
