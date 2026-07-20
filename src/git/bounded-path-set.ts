import { createHash } from "node:crypto";

import { decodeGitUtf8, SnapshotFormatError } from "../core/snapshots.js";

interface ScannedPathSet {
  readonly count: number;
  readonly paths: readonly string[];
  readonly hash: string;
}

export interface RepositoryPathSet {
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
  readonly ignored: readonly string[];
  readonly trackedCount: number;
  readonly untrackedCount: number;
  readonly ignoredCount: number;
  readonly entryCount: number;
  readonly overflowCount: number;
  readonly hash: string;
}

function scanNullPathSet(buffer: Buffer, decodeLimit: number): ScannedPathSet {
  if (!Number.isSafeInteger(decodeLimit) || decodeLimit < 0) {
    throw new TypeError("Git path decode limit is invalid");
  }
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0) {
    throw new SnapshotFormatError(
      "Git structured path output is not NUL terminated",
    );
  }
  const paths: string[] = [];
  let count = 0;
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (paths.length < decodeLimit) {
      paths.push(decodeGitUtf8(buffer.subarray(start, index)));
    }
    count += 1;
    start = index + 1;
  }
  return {
    count,
    paths: Object.freeze(paths),
    hash: createHash("sha256")
      .update("cq-git-null-path-set/v1\0")
      .update(buffer)
      .digest("hex"),
  };
}

export function scanRepositoryPathSet(
  buffers: {
    readonly tracked: Buffer;
    readonly untracked: Buffer;
    readonly ignored: Buffer;
  },
  maxEntries: number,
): RepositoryPathSet {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new TypeError("Repository path entry limit is invalid");
  }
  let remaining = maxEntries;
  const tracked = scanNullPathSet(buffers.tracked, remaining);
  remaining -= tracked.paths.length;
  const untracked = scanNullPathSet(buffers.untracked, remaining);
  remaining -= untracked.paths.length;
  const ignored = scanNullPathSet(buffers.ignored, remaining);
  const entryCount = tracked.count + untracked.count + ignored.count;
  const hash = createHash("sha256")
    .update("cq-repository-path-set/v1\0")
    .update(`${String(tracked.count)}:${tracked.hash}\0`)
    .update(`${String(untracked.count)}:${untracked.hash}\0`)
    .update(`${String(ignored.count)}:${ignored.hash}\0`)
    .digest("hex");
  return Object.freeze({
    tracked: tracked.paths,
    untracked: untracked.paths,
    ignored: ignored.paths,
    trackedCount: tracked.count,
    untrackedCount: untracked.count,
    ignoredCount: ignored.count,
    entryCount,
    overflowCount: Math.max(0, entryCount - maxEntries),
    hash,
  });
}
