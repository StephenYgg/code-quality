import { createHash } from "node:crypto";

import {
  createReviewSnapshot,
  decodeGitUtf8,
  parseGitSnapshotFiles,
  SnapshotFormatError,
  SnapshotLimitError,
  splitNullRecords,
  type ReviewSnapshot,
  type SnapshotExclusion,
} from "../core/snapshots.js";
import {
  GitCommandError,
  resolveTrustedGitExecution,
  type TrustedGitExecution,
} from "./commands.js";
import {
  collectDiffMaterial,
  GitDiffError,
  hashCapturedMaterial,
  type CapturedMaterial,
  type DiffCollectionIo,
  type DiffPlan,
  type LocalInputKind,
} from "./diff.js";
import {
  GitRepositoryError,
  resolveCommit,
  resolveFirstParent,
  resolveGitRepository,
} from "./repository.js";

export type GitInputErrorCode =
  | "GIT_ABORTED"
  | "GIT_COMMAND_FAILED"
  | "GIT_INPUT_LIMIT_EXCEEDED"
  | "GIT_OUTPUT_INVALID"
  | "GIT_REPOSITORY_INVALID"
  | "GIT_REVISION_INVALID"
  | "GIT_SELECTOR_INVALID"
  | "GIT_SOURCE_STALE"
  | "GIT_TIMEOUT"
  | "GIT_UNSAFE_CONFIGURATION";

export class GitInputError extends Error {
  constructor(
    readonly code: GitInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitInputError";
  }
}

export interface LocalGitInputRequest {
  readonly repository: string;
  readonly worktree?: boolean;
  readonly staged?: boolean;
  readonly commit?: string;
  readonly range?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface LocalGitInputIo extends DiffCollectionIo {
  readonly beforeSourceVerification?: () => Promise<void>;
}

interface Selector {
  readonly kind: LocalInputKind;
  readonly commitRevision?: string;
  readonly baseRevision?: string;
  readonly headRevision?: string;
}

function parseSelector(request: LocalGitInputRequest): Selector {
  const selected = [
    request.worktree === true ? "worktree" : undefined,
    request.staged === true ? "staged" : undefined,
    request.commit === undefined ? undefined : "commit",
    request.range === undefined ? undefined : "range",
  ].filter((value): value is LocalInputKind => value !== undefined);
  if (selected.length !== 1) {
    throw new GitInputError(
      "GIT_SELECTOR_INVALID",
      "Exactly one local Git input selector is required",
    );
  }
  const kind = selected[0];
  if (kind === undefined) {
    throw new GitInputError("GIT_SELECTOR_INVALID", "Git selector is missing");
  }
  if (kind === "commit") {
    return { kind, commitRevision: request.commit ?? "" };
  }
  if (kind === "range") {
    const range = request.range ?? "";
    const separator = range.indexOf("..");
    if (
      separator < 1 ||
      separator !== range.lastIndexOf("..") ||
      range.includes("...") ||
      separator + 2 >= range.length
    ) {
      throw new GitInputError(
        "GIT_SELECTOR_INVALID",
        "Range must use the form <base>..<head>",
      );
    }
    return {
      kind,
      baseRevision: range.slice(0, separator),
      headRevision: range.slice(separator + 2),
    };
  }
  return { kind };
}

async function createDiffPlan(
  repository: string,
  selector: Selector,
  execution: TrustedGitExecution,
  signal?: AbortSignal,
): Promise<DiffPlan> {
  if (selector.kind === "worktree" || selector.kind === "staged") {
    const head = await resolveCommit(repository, "HEAD", signal, execution);
    return {
      kind: selector.kind,
      mode: selector.kind,
      comparisonBase: head,
      resolvedHead: head,
    };
  }
  if (selector.kind === "commit") {
    const revision = selector.commitRevision ?? "";
    const head = await resolveCommit(repository, revision, signal, execution);
    const parent = await resolveFirstParent(
      repository,
      head,
      signal,
      execution,
    );
    return {
      kind: "commit",
      mode: parent === undefined ? "root" : "pair",
      ...(parent === undefined ? {} : { comparisonBase: parent }),
      resolvedHead: head,
      commitRevision: revision,
    };
  }
  const baseRevision = selector.baseRevision ?? "";
  const headRevision = selector.headRevision ?? "";
  const base = await resolveCommit(repository, baseRevision, signal, execution);
  const head = await resolveCommit(repository, headRevision, signal, execution);
  return {
    kind: "range",
    mode: "pair",
    comparisonBase: base,
    resolvedHead: head,
    baseRevision,
    headRevision,
  };
}

async function verifySource(
  repository: string,
  plan: DiffPlan,
  materialHash: string,
  io: LocalGitInputIo,
  execution: TrustedGitExecution,
  signal?: AbortSignal,
): Promise<void> {
  if (plan.kind === "commit") {
    const current = await resolveCommit(
      repository,
      plan.commitRevision ?? "",
      signal,
      execution,
    );
    if (current !== plan.resolvedHead) throw new Error("stale");
    return;
  }
  if (plan.kind === "range") {
    const [base, head] = await Promise.all([
      resolveCommit(repository, plan.baseRevision ?? "", signal, execution),
      resolveCommit(repository, plan.headRevision ?? "", signal, execution),
    ]);
    if (base !== plan.comparisonBase || head !== plan.resolvedHead) {
      throw new Error("stale");
    }
    return;
  }
  const head = await resolveCommit(repository, "HEAD", signal, execution);
  const current = await collectDiffMaterial(
    repository,
    plan,
    io,
    execution,
    signal,
  );
  if (
    head !== plan.resolvedHead ||
    hashCapturedMaterial(current) !== materialHash
  ) {
    throw new Error("stale");
  }
}

function exclusionsOf(
  material: CapturedMaterial,
): readonly SnapshotExclusion[] {
  return splitNullRecords(material.untracked ?? Buffer.alloc(0)).map(
    (path) => ({
      path: decodeGitUtf8(path),
      reason: "untracked",
    }),
  );
}

function mapGitCommandErrorCode(
  code: GitCommandError["code"],
): GitInputErrorCode {
  switch (code) {
    case "GIT_ABORTED":
      return "GIT_ABORTED";
    case "GIT_TIMEOUT":
      return "GIT_TIMEOUT";
    case "GIT_STDOUT_LIMIT_EXCEEDED":
    case "GIT_STDERR_LIMIT_EXCEEDED":
      return "GIT_INPUT_LIMIT_EXCEEDED";
    case "GIT_ARGUMENT_INVALID":
      return "GIT_SELECTOR_INVALID";
    case "GIT_COMMAND_FAILED":
    case "GIT_SPAWN_FAILED":
      return "GIT_COMMAND_FAILED";
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function normalizeError(error: unknown): never {
  if (error instanceof GitInputError) throw error;
  if (error instanceof GitDiffError) {
    throw new GitInputError(error.code, error.message);
  }
  if (error instanceof SnapshotFormatError) {
    throw new GitInputError("GIT_OUTPUT_INVALID", error.message);
  }
  if (error instanceof SnapshotLimitError) {
    throw new GitInputError("GIT_INPUT_LIMIT_EXCEEDED", error.message);
  }
  if (error instanceof GitRepositoryError) {
    throw new GitInputError(
      error.code === "GIT_REVISION_INVALID"
        ? "GIT_REVISION_INVALID"
        : "GIT_REPOSITORY_INVALID",
      error.message,
    );
  }
  if (error instanceof GitCommandError) {
    throw new GitInputError(mapGitCommandErrorCode(error.code), error.message);
  }
  throw new GitInputError(
    "GIT_SOURCE_STALE",
    "Git input changed while its snapshot was being collected",
  );
}

async function capture(
  request: LocalGitInputRequest,
  io: LocalGitInputIo,
): Promise<ReviewSnapshot> {
  const selector = parseSelector(request);
  const execution = await resolveTrustedGitExecution(request.repository);
  const repository = await resolveGitRepository(
    request.repository,
    request.signal,
    execution,
  );
  const plan = await createDiffPlan(
    repository,
    selector,
    execution,
    request.signal,
  );
  const material = await collectDiffMaterial(
    repository,
    plan,
    io,
    execution,
    request.signal,
  );
  const sourceHash = hashCapturedMaterial(material);
  await io.beforeSourceVerification?.();
  await verifySource(
    repository,
    plan,
    sourceHash,
    io,
    execution,
    request.signal,
  );
  const exclusions =
    plan.kind === "worktree" ? exclusionsOf(material) : ([] as const);
  const syntheticHead = createHash("sha256")
    .update(plan.kind)
    .update(":")
    .update(plan.resolvedHead)
    .update(":")
    .update(sourceHash)
    .digest("hex");
  return createReviewSnapshot({
    inputKind: plan.kind,
    scope: "change",
    repository,
    ...(plan.comparisonBase === undefined
      ? {}
      : { comparisonBase: plan.comparisonBase }),
    head:
      plan.kind === "commit" || plan.kind === "range"
        ? plan.resolvedHead
        : syntheticHead,
    files: parseGitSnapshotFiles(material.raw, material.numstat),
    diff: decodeGitUtf8(material.patch),
    exclusions,
    incomplete: exclusions.length > 0,
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new GitInputError("GIT_ABORTED", "Git input cancelled");
}

function raceWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      finish(() => {
        reject(abortError(signal));
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(
            error instanceof Error ? error : new Error("Git input failed"),
          );
        });
      },
    );
  });
}

export async function captureLocalGitInput(
  request: LocalGitInputRequest,
  io: LocalGitInputIo = {},
): Promise<ReviewSnapshot> {
  const controller = new AbortController();
  const timeoutError = new GitInputError(
    "GIT_TIMEOUT",
    "Git input collection timed out",
  );
  const onAbort = () => {
    controller.abort(
      new GitInputError("GIT_ABORTED", "Git input collection was cancelled"),
    );
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted === true) controller.abort();
  const timeoutMs = request.timeoutMs ?? 30_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000
  ) {
    throw new GitInputError(
      "GIT_INPUT_LIMIT_EXCEEDED",
      "Git input timeout is outside its hard limit",
    );
  }
  const timeout = setTimeout(() => {
    controller.abort(timeoutError);
  }, timeoutMs);
  timeout.unref();
  try {
    return await raceWithSignal(
      capture({ ...request, signal: controller.signal }, io),
      controller.signal,
    );
  } catch (error) {
    if (controller.signal.reason === timeoutError) throw timeoutError;
    return normalizeError(error);
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
