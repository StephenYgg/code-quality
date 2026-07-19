import { createHash } from "node:crypto";
import { type BigIntStats, type Dir, type Dirent } from "node:fs";
import { opendir, realpath, stat, type FileHandle } from "node:fs/promises";

import { StructuredConfigError } from "./config.js";
import { compareCodeUnits } from "./deterministic-order.js";

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
}

export interface OpenedWaiverDirectory {
  readonly directory: Dir;
  readonly stats: BigIntStats;
}

export interface WaiverDirectoryDescriptor {
  readonly descriptorPath?: string;
  readonly handle: FileHandle;
}

export interface WaiverDirectorySnapshotIo {
  openDescriptor?(path: string): Promise<Dir>;
  stat(path: string): Promise<BigIntStats>;
  statDescriptor?(path: string): Promise<BigIntStats>;
  openDescriptorDirectory?(
    descriptor: WaiverDirectoryDescriptor,
  ): Promise<OpenedWaiverDirectory>;
}

export interface WaiverDirectoryEntry {
  readonly kind:
    | "block"
    | "character"
    | "directory"
    | "fifo"
    | "file"
    | "socket"
    | "symlink"
    | "unknown";
  readonly name: string;
}

interface DirectorySnapshot {
  readonly entries: readonly WaiverDirectoryEntry[];
  readonly entryCount: number;
  readonly sha256: string;
}

export interface StableDirectoryOptions {
  readonly requestedPath: string;
  readonly resolvedPath: string;
  readonly source: string;
  readonly handle: FileHandle;
  readonly io: WaiverDirectorySnapshotIo;
  readonly beforeEnumeration?: () => Promise<void>;
  readonly inspectEntry: () => void;
}

function directoryIdentity(stats: BigIntStats): DirectoryIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    ctimeNs: stats.ctimeNs,
    mtimeNs: stats.mtimeNs,
  };
}

function sameDirectory(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function directoryChanged(source: string): StructuredConfigError {
  return new StructuredConfigError(
    "WAIVER_LOCATION_CHANGED",
    source,
    "Waiver directory changed during policy resolution",
  );
}

function directoryUnsupported(source: string): StructuredConfigError {
  return new StructuredConfigError(
    "WAIVER_DIRECTORY_UNSUPPORTED",
    source,
    "This platform cannot safely enumerate the opened waiver directory descriptor",
  );
}

function entryType(entry: Dirent): WaiverDirectoryEntry["kind"] {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isBlockDevice()) return "block";
  if (entry.isCharacterDevice()) return "character";
  if (entry.isFIFO()) return "fifo";
  if (entry.isSocket()) return "socket";
  return "unknown";
}

function fingerprintEntries(entries: readonly WaiverDirectoryEntry[]): string {
  const hash = createHash("sha256");
  const fingerprints = entries
    .map((entry) => `${entry.kind}:${entry.name}`)
    .sort(compareCodeUnits);
  for (const entry of fingerprints) {
    hash.update(String(Buffer.byteLength(entry, "utf8")));
    hash.update(":");
    hash.update(entry, "utf8");
  }
  return hash.digest("hex");
}

async function pathnameIdentity(
  path: string,
  source: string,
  io: WaiverDirectorySnapshotIo,
): Promise<DirectoryIdentity> {
  try {
    const current = await io.stat(path);
    if (!current.isDirectory()) {
      throw new Error("pathname is not a directory");
    }
    return directoryIdentity(current);
  } catch {
    throw directoryChanged(source);
  }
}

async function verifyDirectory(
  options: StableDirectoryOptions,
  expected: DirectoryIdentity,
): Promise<void> {
  try {
    const descriptorStats = await options.handle.stat({ bigint: true });
    const currentRealPath = await realpath(options.requestedPath);
    const pathnameStats = await stat(currentRealPath, { bigint: true });
    if (
      !descriptorStats.isDirectory() ||
      !pathnameStats.isDirectory() ||
      currentRealPath !== options.resolvedPath ||
      !sameDirectory(directoryIdentity(descriptorStats), expected) ||
      !sameDirectory(directoryIdentity(pathnameStats), expected)
    ) {
      throw new Error("directory identity mismatch");
    }
  } catch {
    throw directoryChanged(options.source);
  }
}

function descriptorPath(handle: FileHandle): string | undefined {
  if (process.platform === "linux") {
    return `/proc/self/fd/${String(handle.fd)}`;
  }
  if (process.platform === "darwin") {
    return `/dev/fd/${String(handle.fd)}`;
  }
  return undefined;
}

function statDescriptor(
  path: string,
  io: WaiverDirectorySnapshotIo,
): Promise<BigIntStats> {
  return io.statDescriptor === undefined
    ? stat(path, { bigint: true })
    : io.statDescriptor(path);
}

function openDescriptor(
  path: string,
  io: WaiverDirectorySnapshotIo,
): Promise<Dir> {
  return io.openDescriptor === undefined
    ? opendir(path)
    : io.openDescriptor(path);
}

async function closeDirectoryAfterFailure(directory: Dir): Promise<void> {
  try {
    await directory.close();
  } catch {
    // Cleanup failure must not replace the fail-closed public diagnostic.
  }
}

async function defaultOpenDirectory(
  descriptor: WaiverDirectoryDescriptor,
  source: string,
  io: WaiverDirectorySnapshotIo,
): Promise<OpenedWaiverDirectory> {
  const path = descriptor.descriptorPath;
  if (path === undefined) {
    throw directoryUnsupported(source);
  }
  try {
    const stats = await statDescriptor(path, io);
    if (!stats.isDirectory()) {
      throw directoryChanged(source);
    }
    const directory = await openDescriptor(path, io);
    return { directory, stats };
  } catch {
    throw directoryUnsupported(source);
  }
}

async function openDirectory(
  options: StableDirectoryOptions,
): Promise<OpenedWaiverDirectory> {
  const path = descriptorPath(options.handle);
  const descriptor: WaiverDirectoryDescriptor = {
    handle: options.handle,
    ...(path === undefined ? {} : { descriptorPath: path }),
  };
  if (options.io.openDescriptorDirectory === undefined) {
    return defaultOpenDirectory(descriptor, options.source, options.io);
  }
  try {
    return await options.io.openDescriptorDirectory(descriptor);
  } catch (error) {
    if (error instanceof StructuredConfigError) {
      throw error;
    }
    throw directoryUnsupported(options.source);
  }
}

async function readSnapshot(
  options: StableDirectoryOptions,
  expected: DirectoryIdentity,
  inspectEntry: (entryCount: number) => void,
): Promise<DirectorySnapshot> {
  const before = await pathnameIdentity(
    options.resolvedPath,
    options.source,
    options.io,
  );
  if (!sameDirectory(before, expected)) {
    throw directoryChanged(options.source);
  }
  const opened = await openDirectory(options);
  if (
    !opened.stats.isDirectory() ||
    !sameDirectory(directoryIdentity(opened.stats), expected)
  ) {
    await closeDirectoryAfterFailure(opened.directory);
    throw directoryChanged(options.source);
  }

  const entries: WaiverDirectoryEntry[] = [];
  for await (const entry of opened.directory) {
    inspectEntry(entries.length + 1);
    entries.push({ kind: entryType(entry), name: entry.name });
  }
  const after = await pathnameIdentity(
    options.resolvedPath,
    options.source,
    options.io,
  );
  if (!sameDirectory(after, expected)) {
    throw directoryChanged(options.source);
  }
  return {
    entries,
    entryCount: entries.length,
    sha256: fingerprintEntries(entries),
  };
}

export async function readStableDirectoryEntries(
  options: StableDirectoryOptions,
): Promise<readonly WaiverDirectoryEntry[]> {
  const initialStats = await options.handle.stat({ bigint: true });
  if (!initialStats.isDirectory()) {
    throw new StructuredConfigError(
      "WAIVER_LOCATION_INVALID",
      options.source,
      "Waiver location is not a directory",
    );
  }
  const expected = directoryIdentity(initialStats);
  await verifyDirectory(options, expected);
  await options.beforeEnumeration?.();
  const first = await readSnapshot(options, expected, () => {
    options.inspectEntry();
  });
  await verifyDirectory(options, expected);
  const second = await readSnapshot(options, expected, (entryCount) => {
    if (entryCount > first.entryCount) {
      throw directoryChanged(options.source);
    }
  });
  await verifyDirectory(options, expected);
  if (
    first.entryCount !== second.entryCount ||
    first.sha256 !== second.sha256
  ) {
    throw directoryChanged(options.source);
  }
  return first.entries;
}
