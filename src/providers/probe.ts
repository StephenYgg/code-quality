import { access, constants, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { BoundedChildError, runBoundedChild } from "./bounded-child-process.js";
import {
  MAX_CONCURRENT_PROBE_CHILDREN,
  ProbeChildCapacity,
} from "./probe-capacity.js";
import { type ProviderDiagnostic, ProviderError } from "./provider.js";

export { MAX_CONCURRENT_PROBE_CHILDREN } from "./probe-capacity.js";

export interface ProcessProbeRequest {
  readonly kind: "codex_cli" | "claude_cli";
  readonly executable: string;
  readonly requiredFlags: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly deadline?: number;
}

export interface ProcessProbeResult {
  readonly diagnostics: readonly ProviderDiagnostic[];
  readonly resolvedExecutable?: string;
  readonly version?: string;
  readonly executableIdentity?: string;
  readonly terminal?: "aborted" | "timeout";
}

export interface ProcessExecutableAttestation {
  readonly resolvedExecutable: string;
  readonly executableIdentity: string;
}

type CaptureStatus =
  "ok" | "failed" | "too_large" | "aborted" | "timeout" | "capacity";

interface CaptureResult {
  readonly status: CaptureStatus;
  readonly output?: string;
}

interface ExecutableIdentity {
  readonly absolute: string;
  readonly key: string;
}

interface SharedProbe<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  waiters: number;
  settled: boolean;
  retired: boolean;
}

const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const MAX_CACHE_ENTRIES = 128;
const versionCache = new Map<string, SharedProbe<CaptureResult>>();
const helpCache = new Map<string, SharedProbe<CaptureResult>>();
const probeChildCapacity = new ProbeChildCapacity(
  MAX_CONCURRENT_PROBE_CHILDREN,
);

class ProbeWaitError extends Error {
  constructor(readonly reason: "aborted" | "timeout") {
    super(`Provider probe ${reason}`);
    this.name = "ProbeWaitError";
  }
}

async function captureOutput(options: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<CaptureResult> {
  if (options.signal.aborted) {
    return Promise.resolve({ status: "aborted" });
  }
  if (options.timeoutMs <= 0) {
    return Promise.resolve({ status: "timeout" });
  }
  const releaseCapacity = probeChildCapacity.tryAcquire();
  if (releaseCapacity === undefined) return { status: "capacity" };
  try {
    const result = await runBoundedChild({
      executable: options.executable,
      args: options.args,
      env: {
        PATH: process.env.PATH ?? "",
        LANG: "C",
        LC_ALL: "C",
        HOME: process.env.HOME,
      },
      timeoutMs: options.timeoutMs,
      maxStdoutBytes: MAX_PROBE_OUTPUT_BYTES,
      maxStderrBytes: MAX_PROBE_OUTPUT_BYTES,
      maxCombinedBytes: MAX_PROBE_OUTPUT_BYTES,
      signal: options.signal,
    });
    const bytes = result.stdout.length + result.stderr.length;
    if (result.exitCode !== 0 || bytes === 0) return { status: "failed" };
    return {
      status: "ok",
      output: Buffer.concat([result.stdout, result.stderr], bytes).toString(
        "utf8",
      ),
    };
  } catch (error) {
    if (!(error instanceof BoundedChildError)) return { status: "failed" };
    if (error.reason === "aborted") return { status: "aborted" };
    if (error.reason === "timeout") return { status: "timeout" };
    if (
      error.reason === "stdout_limit" ||
      error.reason === "stderr_limit" ||
      error.reason === "combined_limit"
    ) {
      return { status: "too_large" };
    }
    return { status: "failed" };
  } finally {
    releaseCapacity();
  }
}

function cacheShared<T>(
  cache: Map<string, SharedProbe<T>>,
  key: string,
  run: (signal: AbortSignal) => Promise<T>,
): SharedProbe<T> | undefined {
  const cached = cache.get(key);
  if (cached !== undefined) {
    if (!cached.retired && !cached.controller.signal.aborted) return cached;
    cache.delete(key);
  }
  if (cache.size >= MAX_CACHE_ENTRIES) {
    for (const [candidateKey, candidate] of cache) {
      if (candidate.settled || candidate.retired) {
        cache.delete(candidateKey);
        break;
      }
    }
    if (cache.size >= MAX_CACHE_ENTRIES) return undefined;
  }
  const controller = new AbortController();
  const entry: SharedProbe<T> = {
    controller,
    promise: run(controller.signal),
    waiters: 0,
    settled: false,
    retired: false,
  };
  cache.set(key, entry);
  void entry.promise.then(
    () => {
      entry.settled = true;
    },
    () => {
      entry.settled = true;
      entry.retired = true;
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  return entry;
}

async function waitForShared<T>(
  entry: SharedProbe<T>,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<T> {
  if (signal?.aborted === true) throw new ProbeWaitError("aborted");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ProbeWaitError("timeout");

  entry.waiters += 1;
  let rejectWait: ((error: ProbeWaitError) => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectWait = reject;
  });
  const onAbort = () => rejectWait?.(new ProbeWaitError("aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => rejectWait?.(new ProbeWaitError("timeout")),
    remaining,
  );
  timeout.unref();
  let interruption: unknown;
  try {
    return await Promise.race([entry.promise, interrupted]);
  } catch (error) {
    interruption = error;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    entry.waiters -= 1;
    if (entry.waiters === 0 && !entry.settled) {
      entry.retired = true;
      entry.controller.abort();
      if (interruption instanceof ProbeWaitError) {
        await entry.promise.catch(() => undefined);
      }
    }
  }
}

async function resolveExecutable(
  executable: string,
): Promise<ExecutableIdentity | readonly ProviderDiagnostic[]> {
  if (!isAbsolute(executable)) {
    return [
      {
        code: "PROVIDER_EXECUTABLE_INVALID",
        message: "Provider executable must be an absolute path",
        path: "/executable",
      },
    ];
  }
  try {
    const absolute = await realpath(executable);
    await access(absolute, constants.X_OK);
    const metadata = await stat(absolute);
    if (!metadata.isFile()) {
      return [
        {
          code: "PROVIDER_EXECUTABLE_INVALID",
          message: "Provider executable is not a regular file",
          path: "/executable",
        },
      ];
    }
    return {
      absolute,
      key: [
        absolute,
        metadata.dev,
        metadata.ino,
        metadata.size,
        metadata.mtimeMs,
        metadata.ctimeMs,
      ].join(":"),
    };
  } catch {
    return [
      {
        code: "PROVIDER_EXECUTABLE_MISSING",
        message: "Provider executable is not accessible",
        path: "/executable",
      },
    ];
  }
}

export async function assertProcessExecutableAttestation(
  configuredExecutable: string,
  attestation: ProcessExecutableAttestation,
): Promise<void> {
  const current = await resolveExecutable(configuredExecutable);
  if (
    isDiagnosticList(current) ||
    current.absolute !== attestation.resolvedExecutable ||
    current.key !== attestation.executableIdentity
  ) {
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Provider executable changed after safe-mode validation",
    );
  }
}

function isDiagnosticList(
  value: ExecutableIdentity | readonly ProviderDiagnostic[],
): value is readonly ProviderDiagnostic[] {
  return Array.isArray(value);
}

function terminalResult(reason: "aborted" | "timeout"): ProcessProbeResult {
  return { diagnostics: [], terminal: reason };
}

function captureFailure(
  capture: CaptureResult,
  phase: "version" | "help",
): ProcessProbeResult | undefined {
  if (capture.status === "ok") return undefined;
  if (capture.status === "capacity") {
    return {
      diagnostics: [
        {
          code: "PROVIDER_PROBE_CAPACITY",
          message: "Provider probe concurrency capacity is exhausted",
          path: "/executable",
        },
      ],
    };
  }
  if (capture.status === "aborted" || capture.status === "timeout") {
    return terminalResult(capture.status);
  }
  return {
    diagnostics: [
      {
        code: "PROVIDER_PROBE_FAILED",
        message: `Provider ${phase} probe failed, exceeded its output limit, or timed out`,
        path: "/executable",
      },
    ],
  };
}

function probeDeadline(request: ProcessProbeRequest): number {
  const local = Date.now() + (request.timeoutMs ?? 3_000);
  return Math.min(local, request.deadline ?? Number.POSITIVE_INFINITY);
}

function parseHelpOptions(output: string): ReadonlySet<string> {
  const options = new Set<string>();
  const pattern = /(?:^|[\s,])(--?[A-Za-z0-9][A-Za-z0-9-]*)(?=$|[\s,=<[({])/gmu;
  for (const match of output.matchAll(pattern)) {
    const option = match[1];
    if (option !== undefined) options.add(option);
  }
  return options;
}

async function waitForCapture(
  cache: Map<string, SharedProbe<CaptureResult>>,
  key: string,
  options: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly deadline: number;
  },
): Promise<CaptureResult> {
  if (options.signal?.aborted === true) throw new ProbeWaitError("aborted");
  if (options.deadline <= Date.now()) throw new ProbeWaitError("timeout");
  const entry = cacheShared(cache, key, (signal) =>
    captureOutput({
      executable: options.executable,
      args: options.args,
      timeoutMs: options.timeoutMs,
      signal,
    }),
  );
  if (entry === undefined) return { status: "capacity" };
  try {
    const result = await waitForShared(entry, options.signal, options.deadline);
    if (result.status !== "ok") {
      entry.retired = true;
      if (cache.get(key) === entry) cache.delete(key);
    }
    return result;
  } catch (error) {
    if (entry.waiters === 0) {
      entry.retired = true;
      if (cache.get(key) === entry) cache.delete(key);
    }
    throw error;
  }
}

export async function probeProcessVersion(options: {
  readonly executable: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly deadline?: number;
}): Promise<ProcessProbeResult> {
  const resolved = await resolveExecutable(options.executable);
  if (isDiagnosticList(resolved)) return { diagnostics: resolved };
  const timeoutMs = options.timeoutMs ?? 3_000;
  const deadline = Math.min(
    Date.now() + timeoutMs,
    options.deadline ?? Number.POSITIVE_INFINITY,
  );
  try {
    const version = await waitForCapture(versionCache, resolved.key, {
      executable: resolved.absolute,
      args: ["--version"],
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      deadline,
    });
    const failure = captureFailure(version, "version");
    if (failure !== undefined) return failure;
    const output = version.output?.trim().slice(0, 300);
    if (output === undefined) {
      return {
        diagnostics: [
          {
            code: "PROVIDER_PROBE_FAILED",
            message: "Provider version probe returned no usable version",
            path: "/executable",
          },
        ],
      };
    }
    return {
      diagnostics: [],
      resolvedExecutable: resolved.absolute,
      version: output,
      executableIdentity: resolved.key,
    };
  } catch (error) {
    if (error instanceof ProbeWaitError) return terminalResult(error.reason);
    throw error;
  }
}

export async function probeProcessProviderResult(
  request: ProcessProbeRequest,
): Promise<ProcessProbeResult> {
  const deadline = probeDeadline(request);
  const version = await probeProcessVersion({
    executable: request.executable,
    timeoutMs: request.timeoutMs ?? 3_000,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    deadline,
  });
  if (version.terminal !== undefined || version.diagnostics.length > 0) {
    return version;
  }
  if (
    version.resolvedExecutable === undefined ||
    version.version === undefined
  ) {
    return {
      diagnostics: [
        {
          code: "PROVIDER_PROBE_FAILED",
          message: "Provider version probe returned no usable version",
          path: "/executable",
        },
      ],
    };
  }

  const helpArgs =
    request.kind === "codex_cli" ? ["exec", "--help"] : ["--help"];
  const helpKey = [
    version.executableIdentity ?? version.resolvedExecutable,
    version.version,
    request.kind,
    ...request.requiredFlags,
  ].join("\0");
  try {
    const help = await waitForCapture(helpCache, helpKey, {
      executable: version.resolvedExecutable,
      args: helpArgs,
      timeoutMs: request.timeoutMs ?? 3_000,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      deadline,
    });
    const failure = captureFailure(help, "help");
    if (failure !== undefined) return failure;
    const output = help.output ?? "";
    const supportedOptions = parseHelpOptions(output);
    return {
      diagnostics: request.requiredFlags
        .filter((flag) => !supportedOptions.has(flag))
        .map((flag) => ({
          code: "PROVIDER_SAFE_MODE_UNSUPPORTED",
          message: `Installed provider does not expose required safe-mode flag ${flag}`,
          path: "/executable",
        })),
      resolvedExecutable: version.resolvedExecutable,
      version: version.version,
      ...(version.executableIdentity === undefined
        ? {}
        : { executableIdentity: version.executableIdentity }),
    };
  } catch (error) {
    if (error instanceof ProbeWaitError) return terminalResult(error.reason);
    throw error;
  }
}

export async function probeProcessProvider(
  request: ProcessProbeRequest,
): Promise<readonly ProviderDiagnostic[]> {
  const result = await probeProcessProviderResult(request);
  if (result.terminal === undefined) return result.diagnostics;
  return [
    {
      code:
        result.terminal === "aborted"
          ? "PROVIDER_PROBE_ABORTED"
          : "PROVIDER_PROBE_TIMEOUT",
      message:
        result.terminal === "aborted"
          ? "Provider probe was cancelled"
          : "Provider probe timed out",
      path: "/executable",
    },
  ];
}

export const CODEX_REQUIRED_FLAGS = [
  "--sandbox",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--skip-git-repo-check",
  "-c",
  "--color",
  "--json",
  "--output-schema",
  "--output-last-message",
  "--model",
  "-C",
] as const;

export const CLAUDE_REQUIRED_FLAGS = [
  "--print",
  "--safe-mode",
  "--tools",
  "--permission-mode",
  "--output-format",
  "--json-schema",
  "--model",
  "--no-session-persistence",
] as const;
