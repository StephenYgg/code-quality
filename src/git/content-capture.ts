import { TextDecoder } from "node:util";

import type {
  SnapshotExclusion,
  SnapshotExclusionReason,
  SnapshotFile,
} from "../core/snapshots.js";
import {
  GitCommandError,
  runGitCommand,
  type TrustedGitExecution,
} from "./commands.js";
import type { LocalInputKind } from "./diff.js";
import {
  classifyRepositoryPath,
  isBinaryContent,
  looksLikeSecret,
} from "./repository-manifest.js";
import {
  inspectWorktreePath,
  safeReadWorktreeFile,
  sameWorktreeEpoch,
  WorktreeSourceStaleError,
  type WorktreePathEpoch,
} from "./safe-worktree-read.js";

export const MAX_CAPTURED_CONTENT_FILES = 40;
export const MAX_CAPTURED_FILE_BYTES = 64 * 1024;
export const MAX_CAPTURED_FILE_PROBE_BYTES = MAX_CAPTURED_FILE_BYTES + 1;
export const MAX_CAPTURED_TOTAL_BYTES = 512 * 1024;

export class ContentCaptureError extends Error {
  constructor(
    readonly code: "GIT_SOURCE_STALE",
    message: string,
  ) {
    super(message);
    this.name = "ContentCaptureError";
  }
}

export interface ContentCaptureRequest {
  readonly repository: string;
  readonly kind: LocalInputKind;
  readonly files: readonly SnapshotFile[];
  readonly execution: TrustedGitExecution;
  readonly worktreeEpochByPath?: ReadonlyMap<string, WorktreePathEpoch>;
  readonly signal?: AbortSignal;
}

export interface ContentCaptureResult {
  readonly captured: readonly (readonly [string, Buffer])[];
  readonly omissions: readonly SnapshotExclusion[];
}

type ContentReadResult =
  | { readonly ok: true; readonly bytes: Buffer; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: SnapshotExclusionReason };

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export async function captureWorktreeEpochs(
  repository: string,
  files: readonly SnapshotFile[],
): Promise<ReadonlyMap<string, WorktreePathEpoch>> {
  const epochs = new Map<string, WorktreePathEpoch>();
  const selected = files
    .filter((file) => file.status !== "deleted" && !file.binary)
    .slice(0, MAX_CAPTURED_CONTENT_FILES);
  for (const file of selected) {
    const epoch = await inspectWorktreePath(repository, file.path);
    if (epoch !== undefined) epochs.set(file.path, epoch);
  }
  return epochs;
}

export async function captureContentEntries(
  request: ContentCaptureRequest,
): Promise<ContentCaptureResult> {
  const eligible = request.files.filter(
    (file) => file.status !== "deleted" && !file.binary,
  );
  const files = eligible.slice(0, MAX_CAPTURED_CONTENT_FILES);
  const captured: (readonly [string, Buffer])[] = [];
  const omissions: SnapshotExclusion[] = eligible
    .slice(MAX_CAPTURED_CONTENT_FILES)
    .map((file) => ({ path: file.path, reason: "file_limit" }));
  let totalBytes = 0;
  for (const file of files) {
    const pathReason = classifyRepositoryPath(file.path);
    if (pathReason !== undefined) {
      omissions.push({ path: file.path, reason: pathReason });
      continue;
    }
    const remaining = MAX_CAPTURED_TOTAL_BYTES - totalBytes;
    if (remaining < 1) {
      omissions.push({ path: file.path, reason: "aggregate_byte_limit" });
      continue;
    }
    const acceptedLimit = Math.min(MAX_CAPTURED_FILE_BYTES, remaining);
    const probeLimit = Math.min(
      MAX_CAPTURED_FILE_PROBE_BYTES,
      acceptedLimit + 1,
    );
    const read =
      request.kind === "worktree"
        ? await readWorktreePath(request, file.path, probeLimit)
        : await readGitBlob(request, file, probeLimit);
    if (!read.ok) {
      omissions.push({
        path: file.path,
        reason:
          read.reason === "file_limit" &&
          acceptedLimit < MAX_CAPTURED_FILE_BYTES
            ? "aggregate_byte_limit"
            : read.reason,
      });
      continue;
    }
    if (read.truncated || read.bytes.length > acceptedLimit) {
      omissions.push({
        path: file.path,
        reason:
          acceptedLimit < MAX_CAPTURED_FILE_BYTES
            ? "aggregate_byte_limit"
            : "file_limit",
      });
      continue;
    }
    if (isBinaryContent(read.bytes)) {
      omissions.push({ path: file.path, reason: "binary" });
      continue;
    }
    try {
      fatalUtf8Decoder.decode(read.bytes);
    } catch {
      omissions.push({ path: file.path, reason: "unsupported" });
      continue;
    }
    if (looksLikeSecret(read.bytes)) {
      omissions.push({ path: file.path, reason: "suspected_secret" });
      continue;
    }
    captured.push([file.path, read.bytes]);
    totalBytes += read.bytes.length;
  }
  return Object.freeze({
    captured: Object.freeze(captured),
    omissions: Object.freeze(omissions),
  });
}

export async function verifyWorktreeEpochs(
  repository: string,
  epochs: ReadonlyMap<string, WorktreePathEpoch>,
): Promise<void> {
  for (const [path, expected] of epochs) {
    const current = await inspectWorktreePath(repository, path);
    if (current === undefined || !sameWorktreeEpoch(expected, current)) {
      throw new ContentCaptureError(
        "GIT_SOURCE_STALE",
        "Worktree path identity changed after content capture",
      );
    }
  }
}

async function readGitBlob(
  request: ContentCaptureRequest,
  file: SnapshotFile,
  limit: number,
): Promise<ContentReadResult> {
  const objectId = file.newObjectId;
  if (
    objectId === undefined ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(objectId) ||
    /^0+$/u.test(objectId)
  ) {
    return { ok: false, reason: "read_or_identity_error" };
  }
  try {
    const bytes = (
      await runGitCommand({
        repository: request.repository,
        args: ["cat-file", "blob", objectId],
        execution: request.execution,
        maximumStdoutBytes: limit,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    ).stdout;
    return { ok: true, bytes, truncated: false };
  } catch (error) {
    if (
      error instanceof GitCommandError &&
      (error.code === "GIT_ABORTED" || error.code === "GIT_TIMEOUT")
    ) {
      throw error;
    }
    return {
      ok: false,
      reason:
        error instanceof GitCommandError &&
        error.code === "GIT_STDOUT_LIMIT_EXCEEDED"
          ? "file_limit"
          : "read_or_identity_error",
    };
  }
}

async function readWorktreePath(
  request: ContentCaptureRequest,
  path: string,
  limit: number,
): Promise<ContentReadResult> {
  try {
    const expectedEpoch = request.worktreeEpochByPath?.get(path);
    const result = await safeReadWorktreeFile({
      repository: request.repository,
      path,
      maxBytes: limit,
      truncate: true,
      ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
    });
    return result.ok
      ? { ok: true, bytes: result.bytes, truncated: result.truncated }
      : { ok: false, reason: result.reason };
  } catch (error) {
    if (error instanceof WorktreeSourceStaleError) {
      throw new ContentCaptureError("GIT_SOURCE_STALE", error.message);
    }
    throw error;
  }
}
