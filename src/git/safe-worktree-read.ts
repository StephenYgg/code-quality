import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export type SafeWorktreeReadReason =
  "file_limit" | "read_or_identity_error" | "symlink" | "unsupported_type";

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface WorktreePathEpoch {
  readonly path: string;
  readonly parents: readonly FileIdentity[];
  readonly leaf: FileIdentity;
}

export class WorktreeSourceStaleError extends Error {
  constructor(message = "Worktree path identity changed during capture") {
    super(message);
    this.name = "WorktreeSourceStaleError";
  }
}

type InspectedPath =
  | {
      readonly ok: true;
      readonly absolute: string;
      readonly epoch: WorktreePathEpoch;
    }
  | { readonly ok: false; readonly reason: SafeWorktreeReadReason };

export type SafeWorktreeReadResult =
  | {
      readonly ok: true;
      readonly bytes: Buffer;
      readonly epoch: WorktreePathEpoch;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly reason: SafeWorktreeReadReason };

function validRelativePath(path: string): boolean {
  const segments = path.split("/");
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    )
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

function identity(metadata: BigIntStats): FileIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function sameWorktreeEpoch(
  left: WorktreePathEpoch,
  right: WorktreePathEpoch,
): boolean {
  return (
    left.path === right.path &&
    left.parents.length === right.parents.length &&
    left.parents.every((item, index) =>
      sameIdentity(item, right.parents[index] ?? item),
    ) &&
    sameIdentity(left.leaf, right.leaf)
  );
}

async function inspectPath(root: string, path: string): Promise<InspectedPath> {
  if (!validRelativePath(path)) {
    return { ok: false, reason: "read_or_identity_error" };
  }
  const segments = path.split("/");
  const parents: FileIdentity[] = [];
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const metadata = await lstat(current, { bigint: true });
    if (metadata.isSymbolicLink()) return { ok: false, reason: "symlink" };
    if (!metadata.isDirectory())
      return { ok: false, reason: "unsupported_type" };
    const resolved = await realpath(current);
    const resolvedMetadata = await stat(resolved, { bigint: true });
    if (
      !isContained(root, resolved) ||
      !sameIdentity(identity(metadata), identity(resolvedMetadata))
    ) {
      return { ok: false, reason: "read_or_identity_error" };
    }
    parents.push(identity(metadata));
  }
  const absolute = join(root, ...segments);
  const leaf = await lstat(absolute, { bigint: true });
  if (leaf.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!leaf.isFile()) return { ok: false, reason: "unsupported_type" };
  const resolvedLeaf = await realpath(absolute);
  if (!isContained(root, resolvedLeaf)) {
    return { ok: false, reason: "read_or_identity_error" };
  }
  return { ok: true, absolute, epoch: { path, parents, leaf: identity(leaf) } };
}

async function descriptorPath(handle: FileHandle): Promise<string | undefined> {
  for (const path of [
    `/proc/self/fd/${handle.fd.toString()}`,
    `/dev/fd/${handle.fd.toString()}`,
  ]) {
    try {
      const resolved = await realpath(path);
      if (
        resolved === path ||
        resolved.startsWith("/dev/fd/") ||
        resolved.startsWith("/proc/self/fd/")
      ) {
        continue;
      }
      return resolved;
    } catch {
      // Descriptor links are platform-specific.
    }
  }
  return undefined;
}

async function readDescriptor(
  handle: FileHandle,
  size: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = await handle.read(buffer, offset, size - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  if (offset !== size) throw new WorktreeSourceStaleError();
  return buffer;
}

async function readInspectedPath(options: {
  readonly root: string;
  readonly inspected: Extract<InspectedPath, { readonly ok: true }>;
  readonly maxBytes: number;
  readonly truncate: boolean;
}): Promise<SafeWorktreeReadResult> {
  const { inspected } = options;
  if (
    inspected.epoch.leaf.size > BigInt(options.maxBytes) &&
    !options.truncate
  ) {
    return { ok: false, reason: "file_limit" };
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      inspected.absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const descriptor = identity(await handle.stat({ bigint: true }));
    const target = await descriptorPath(handle);
    if (
      !sameIdentity(inspected.epoch.leaf, descriptor) ||
      (target !== undefined && !isContained(options.root, target))
    ) {
      throw new WorktreeSourceStaleError();
    }
    const size = Number(
      descriptor.size < BigInt(options.maxBytes)
        ? descriptor.size
        : BigInt(options.maxBytes),
    );
    const bytes = await readDescriptor(handle, size);
    const afterDescriptor = identity(await handle.stat({ bigint: true }));
    const afterPath = await inspectPath(options.root, inspected.epoch.path);
    if (
      !sameIdentity(descriptor, afterDescriptor) ||
      !afterPath.ok ||
      !sameWorktreeEpoch(inspected.epoch, afterPath.epoch)
    ) {
      throw new WorktreeSourceStaleError();
    }
    return {
      ok: true,
      bytes,
      epoch: inspected.epoch,
      truncated: descriptor.size > BigInt(options.maxBytes),
    };
  } finally {
    await handle?.close();
  }
}

export async function inspectWorktreePath(
  repository: string,
  path: string,
): Promise<WorktreePathEpoch | undefined> {
  try {
    const inspected = await inspectPath(await realpath(repository), path);
    return inspected.ok ? inspected.epoch : undefined;
  } catch {
    return undefined;
  }
}

export async function safeReadWorktreeFile(options: {
  readonly repository: string;
  readonly path: string;
  readonly maxBytes: number;
  readonly truncate?: boolean;
  readonly expectedEpoch?: WorktreePathEpoch;
}): Promise<SafeWorktreeReadResult> {
  const root = await realpath(options.repository);
  try {
    const inspected = await inspectPath(root, options.path);
    if (!inspected.ok) {
      if (options.expectedEpoch !== undefined) {
        throw new WorktreeSourceStaleError();
      }
      return inspected;
    }
    if (
      options.expectedEpoch !== undefined &&
      !sameWorktreeEpoch(options.expectedEpoch, inspected.epoch)
    ) {
      throw new WorktreeSourceStaleError();
    }
    return await readInspectedPath({
      root,
      inspected,
      maxBytes: options.maxBytes,
      truncate: options.truncate === true,
    });
  } catch (error) {
    if (error instanceof WorktreeSourceStaleError) throw error;
    return { ok: false, reason: "read_or_identity_error" };
  }
}
