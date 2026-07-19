import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { compareCodeUnits } from "./deterministic-order.js";

export const MAX_SNAPSHOT_FILES = 200;
export const MAX_SNAPSHOT_EXCLUSIONS = 400;
export const MAX_SNAPSHOT_DIFF_BYTES = 2 * 1024 * 1024;
export const MAX_SNAPSHOT_CHANGED_LINES = 10_000;
export const MAX_SNAPSHOT_PATH_BYTES = 4 * 1024;

export type ReviewInputKind =
  | "worktree"
  | "staged"
  | "commit"
  | "range"
  | "repository"
  | "github_pr"
  | "gitlab_mr";

export type SnapshotFileStatus =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type_changed"
  | "unmerged"
  | "unknown";

export interface SnapshotFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: SnapshotFileStatus;
  readonly binary: boolean;
  readonly additions?: number;
  readonly deletions?: number;
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly oldObjectId?: string;
  readonly newObjectId?: string;
}

export type SnapshotExclusionReason =
  | "binary"
  | "limit"
  | "unsupported"
  | "untracked"
  | "git_metadata"
  | "git_ignored"
  | "dependency"
  | "generated"
  | "cache"
  | "suspected_secret"
  | "unsupported_type"
  | "path_limit"
  | "file_limit"
  | "entry_limit"
  | "aggregate_file_limit"
  | "aggregate_byte_limit"
  | "read_or_identity_error"
  | "symlink"
  | "profile";

export interface SnapshotExclusion {
  readonly reason: SnapshotExclusionReason;
  readonly path?: string;
}

export interface ReviewSnapshot {
  readonly inputKind: ReviewInputKind;
  readonly scope: "change" | "repository";
  readonly repository: string;
  readonly comparisonBase?: string;
  readonly head: string;
  readonly contentHash: string;
  readonly files: readonly SnapshotFile[];
  readonly diff?: string;
  readonly exclusions: readonly SnapshotExclusion[];
  readonly incomplete: boolean;
}

export type ReviewSnapshotSource = Omit<ReviewSnapshot, "contentHash">;

export class SnapshotLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotLimitError";
  }
}

export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFormatError";
  }
}

export function hashSnapshotParts(
  parts: readonly (Buffer | undefined)[],
): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part === undefined ? "-1:" : `${part.length.toString()}:`);
    if (part !== undefined) hash.update(part);
  }
  return hash.digest("hex");
}

interface NumericStats {
  readonly additions?: number;
  readonly deletions?: number;
  readonly binary: boolean;
  readonly previousPath?: string;
}

export function splitNullRecords(buffer: Buffer): readonly Buffer[] {
  if (buffer.length === 0) return [];
  if (buffer[buffer.length - 1] !== 0) {
    throw new SnapshotFormatError(
      "Git structured output is not NUL terminated",
    );
  }
  const values: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      values.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  return values;
}

export function decodeGitUtf8(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new SnapshotFormatError("Git output is not valid UTF-8");
  }
}

function statusOf(value: string): SnapshotFileStatus {
  const statuses: Readonly<Record<string, SnapshotFileStatus>> = {
    A: "added",
    C: "copied",
    D: "deleted",
    M: "modified",
    R: "renamed",
    T: "type_changed",
    U: "unmerged",
  };
  const status = statuses[value[0] ?? ""];
  if (status === undefined) {
    throw new SnapshotFormatError("Git raw diff status is unsupported");
  }
  return status;
}

function parseNumstat(buffer: Buffer): ReadonlyMap<string, NumericStats> {
  const tokens = splitNullRecords(buffer);
  const stats = new Map<string, NumericStats>();
  for (let index = 0; index < tokens.length; index += 1) {
    const record = decodeGitUtf8(tokens[index] ?? Buffer.alloc(0));
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 1) {
      throw new SnapshotFormatError("Git numstat is invalid");
    }
    const additions = record.slice(0, firstTab);
    const deletions = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    let previousPath: string | undefined;
    if (path.length === 0) {
      index += 2;
      if (index >= tokens.length) {
        throw new SnapshotFormatError("Git rename numstat is invalid");
      }
      previousPath = decodeGitUtf8(tokens[index - 1] ?? Buffer.alloc(0));
      path = decodeGitUtf8(tokens[index] ?? Buffer.alloc(0));
    }
    const additionsBinary = additions === "-";
    const deletionsBinary = deletions === "-";
    if (additionsBinary !== deletionsBinary) {
      throw new SnapshotFormatError("Git binary numstat is incomplete");
    }
    const binary = additionsBinary;
    const additionsValue = Number(additions);
    const deletionsValue = Number(deletions);
    if (
      !binary &&
      (!/^[0-9]+$/u.test(additions) ||
        !/^[0-9]+$/u.test(deletions) ||
        !Number.isSafeInteger(additionsValue) ||
        !Number.isSafeInteger(deletionsValue))
    ) {
      throw new SnapshotFormatError("Git numstat count is invalid");
    }
    if (stats.has(path)) {
      throw new SnapshotFormatError("Git numstat contains duplicate paths");
    }
    stats.set(path, {
      binary,
      ...(binary
        ? {}
        : { additions: additionsValue, deletions: deletionsValue }),
      ...(previousPath === undefined ? {} : { previousPath }),
    });
  }
  return stats;
}

export function parseGitSnapshotFiles(
  raw: Buffer,
  numstat: Buffer,
): readonly SnapshotFile[] {
  const tokens = splitNullRecords(raw);
  const stats = parseNumstat(numstat);
  const files: SnapshotFile[] = [];
  const rawPaths = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const header = decodeGitUtf8(tokens[index] ?? Buffer.alloc(0));
    const fields = header.startsWith(":") ? header.slice(1).split(" ") : [];
    if (fields.length !== 5)
      throw new SnapshotFormatError("Git raw diff is invalid");
    const status = statusOf(fields[4] ?? "");
    const firstPath = decodeGitUtf8(tokens[(index += 1)] ?? Buffer.alloc(0));
    const renamed = status === "renamed" || status === "copied";
    const path = renamed
      ? decodeGitUtf8(tokens[(index += 1)] ?? Buffer.alloc(0))
      : firstPath;
    const numeric = stats.get(path);
    if (numeric === undefined) {
      throw new SnapshotFormatError("Git raw and numstat paths do not match");
    }
    if (rawPaths.has(path)) {
      throw new SnapshotFormatError("Git raw diff contains duplicate paths");
    }
    rawPaths.add(path);
    if (
      (renamed && numeric.previousPath !== firstPath) ||
      (!renamed && numeric.previousPath !== undefined)
    ) {
      throw new SnapshotFormatError("Git rename paths do not match");
    }
    files.push({
      path,
      ...(renamed ? { previousPath: firstPath } : {}),
      status,
      binary: numeric.binary,
      ...(numeric.additions === undefined
        ? {}
        : { additions: numeric.additions }),
      ...(numeric.deletions === undefined
        ? {}
        : { deletions: numeric.deletions }),
      oldMode: fields[0] ?? "",
      newMode: fields[1] ?? "",
      oldObjectId: fields[2] ?? "",
      newObjectId: fields[3] ?? "",
    });
  }
  if (stats.size !== files.length) {
    throw new SnapshotFormatError("Git numstat contains residual paths");
  }
  return files;
}

export interface GitDiffEnvelope {
  readonly raw: Buffer;
  readonly numstat: Buffer;
  readonly patch: Buffer;
  readonly files: readonly SnapshotFile[];
}

function joinNullRecords(records: readonly Buffer[]): Buffer {
  return Buffer.concat(records.flatMap((record) => [record, Buffer.from([0])]));
}

export function parseGitDiffEnvelope(output: Buffer): GitDiffEnvelope {
  if (output.length === 0) {
    return { raw: output, numstat: output, patch: output, files: [] };
  }
  const marker = Buffer.from("\0\0diff --git ", "utf8");
  const boundary = output.indexOf(marker);
  if (boundary < 0) {
    throw new SnapshotFormatError("Git diff envelope boundary is missing");
  }
  const metadata = output.subarray(0, boundary + 1);
  const tokens = splitNullRecords(metadata);
  const rawTokens: Buffer[] = [];
  let index = 0;
  while (index < tokens.length) {
    const header = decodeGitUtf8(tokens[index] ?? Buffer.alloc(0));
    if (!header.startsWith(":")) break;
    rawTokens.push(tokens[index] ?? Buffer.alloc(0));
    index += 1;
    rawTokens.push(tokens[index] ?? Buffer.alloc(0));
    index += 1;
    const status = header.slice(header.lastIndexOf(" ") + 1);
    if (status.startsWith("R") || status.startsWith("C")) {
      rawTokens.push(tokens[index] ?? Buffer.alloc(0));
      index += 1;
    }
  }
  const raw = joinNullRecords(rawTokens);
  const numstat = joinNullRecords(tokens.slice(index));
  const patch = output.subarray(boundary + 2);
  return { raw, numstat, patch, files: parseGitSnapshotFiles(raw, numstat) };
}

function validatePath(path: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    ) ||
    Buffer.byteLength(path, "utf8") > MAX_SNAPSHOT_PATH_BYTES
  ) {
    throw new SnapshotLimitError(
      "Snapshot path is invalid or exceeds its limit",
    );
  }
}

function snapshotFile(file: SnapshotFile): SnapshotFile {
  validatePath(file.path);
  if (file.previousPath !== undefined) validatePath(file.previousPath);
  for (const count of [file.additions, file.deletions]) {
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
      throw new SnapshotLimitError("Snapshot line count is invalid");
    }
  }
  for (const mode of [file.oldMode, file.newMode]) {
    if (mode !== undefined && !/^[0-7]{6}$/u.test(mode)) {
      throw new SnapshotLimitError("Snapshot file mode is invalid");
    }
  }
  for (const objectId of [file.oldObjectId, file.newObjectId]) {
    if (
      objectId !== undefined &&
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(objectId)
    ) {
      throw new SnapshotLimitError("Snapshot object ID is invalid");
    }
  }
  return Object.freeze({ ...file });
}

function snapshotExclusion(exclusion: SnapshotExclusion): SnapshotExclusion {
  if (exclusion.path !== undefined) validatePath(exclusion.path);
  if (
    exclusion.reason.length === 0 ||
    Buffer.byteLength(exclusion.reason, "utf8") > 256
  ) {
    throw new SnapshotLimitError("Snapshot exclusion reason is invalid");
  }
  return Object.freeze({ ...exclusion });
}

function canonicalSnapshot(
  source: ReviewSnapshotSource,
  files: readonly SnapshotFile[],
  exclusions: readonly SnapshotExclusion[],
): string {
  return JSON.stringify({
    inputKind: source.inputKind,
    scope: source.scope,
    comparisonBase: source.comparisonBase ?? null,
    head: source.head,
    files: files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status,
      binary: file.binary,
      additions: file.additions ?? null,
      deletions: file.deletions ?? null,
      oldMode: file.oldMode ?? null,
      newMode: file.newMode ?? null,
      oldObjectId: file.oldObjectId ?? null,
      newObjectId: file.newObjectId ?? null,
    })),
    diff: source.diff ?? null,
    exclusions: exclusions.map((exclusion) => ({
      reason: exclusion.reason,
      path: exclusion.path ?? null,
    })),
    incomplete: source.incomplete,
  });
}

function changedLines(files: readonly SnapshotFile[]): number {
  return files.reduce(
    (total, file) => total + (file.additions ?? 0) + (file.deletions ?? 0),
    0,
  );
}

export function createReviewSnapshot(
  source: ReviewSnapshotSource,
): ReviewSnapshot {
  if (
    source.files.length > MAX_SNAPSHOT_FILES ||
    source.exclusions.length > MAX_SNAPSHOT_EXCLUSIONS ||
    changedLines(source.files) > MAX_SNAPSHOT_CHANGED_LINES ||
    (source.diff !== undefined &&
      Buffer.byteLength(source.diff, "utf8") > MAX_SNAPSHOT_DIFF_BYTES)
  ) {
    throw new SnapshotLimitError("Snapshot exceeds its hard resource limits");
  }
  const files = Object.freeze(
    source.files
      .map(snapshotFile)
      .sort(
        (left, right) =>
          compareCodeUnits(left.path, right.path) ||
          compareCodeUnits(left.previousPath ?? "", right.previousPath ?? ""),
      ),
  );
  const exclusions = Object.freeze(
    source.exclusions
      .map(snapshotExclusion)
      .sort(
        (left, right) =>
          compareCodeUnits(left.path ?? "", right.path ?? "") ||
          compareCodeUnits(left.reason, right.reason),
      ),
  );
  const contentHash = createHash("sha256")
    .update("cq-review-snapshot/v1\0", "utf8")
    .update(canonicalSnapshot(source, files, exclusions), "utf8")
    .digest("hex");
  return Object.freeze({
    inputKind: source.inputKind,
    scope: source.scope,
    repository: source.repository,
    ...(source.comparisonBase === undefined
      ? {}
      : { comparisonBase: source.comparisonBase }),
    head: source.head,
    contentHash,
    files,
    ...(source.diff === undefined ? {} : { diff: source.diff }),
    exclusions,
    incomplete: source.incomplete,
  });
}
