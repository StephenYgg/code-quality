import { constants } from "node:fs";
import { chmod, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { resolveCodexNativeExecutable } from "./codex-native.js";
import { validateExecutableSource } from "./executable-source.js";
import { type ProviderKind, ProviderError } from "./provider.js";

export const MAX_ACTIVE_EXECUTABLE_SNAPSHOTS = 2;
export const MAX_EXECUTABLE_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const MAX_EXECUTABLE_SNAPSHOT_RESERVED_BYTES = 512 * 1024 * 1024;
const COPY_CHUNK_BYTES = 64 * 1024;

let activeSnapshots = 0;
let reservedBytes = 0;

export interface ExecutableSnapshot {
  readonly path: string;
  readonly sourcePath: string;
  readonly size: number;
  release(): Promise<void>;
}

interface SnapshotOptions {
  readonly kind: Extract<ProviderKind, "codex_cli" | "claude_cli">;
  readonly executable: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly removeDirectory?: (path: string) => Promise<void>;
}

function assertActive(signal: AbortSignal, deadline: number): void {
  if (signal.aborted) {
    throw new ProviderError("PROVIDER_ABORTED", "Provider call was cancelled");
  }
  if (deadline <= Date.now()) {
    throw new ProviderError("PROVIDER_TIMEOUT", "Provider call timed out");
  }
}

function reserveSnapshot(size: number): (() => void) | undefined {
  if (
    activeSnapshots >= MAX_ACTIVE_EXECUTABLE_SNAPSHOTS ||
    reservedBytes + size > MAX_EXECUTABLE_SNAPSHOT_RESERVED_BYTES
  ) {
    return undefined;
  }
  activeSnapshots += 1;
  reservedBytes += size;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSnapshots -= 1;
    reservedBytes -= size;
  };
}

async function resolveSource(options: SnapshotOptions): Promise<string> {
  const configured = await realpath(options.executable);
  if (options.kind !== "codex_cli") return configured;
  return (await resolveCodexNativeExecutable(configured)) ?? configured;
}

async function copyFixedBytes(options: {
  readonly source: Awaited<ReturnType<typeof open>>;
  readonly destination: Awaited<ReturnType<typeof open>>;
  readonly size: number;
  readonly signal: AbortSignal;
  readonly deadline: number;
}): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, options.size));
  let offset = 0;
  while (offset < options.size) {
    assertActive(options.signal, options.deadline);
    const length = Math.min(buffer.length, options.size - offset);
    const read = await options.source.read(buffer, 0, length, offset);
    if (read.bytesRead === 0) {
      throw new ProviderError(
        "PROVIDER_UNSAFE",
        "Provider executable changed while it was snapshotted",
      );
    }
    let written = 0;
    while (written < read.bytesRead) {
      const result = await options.destination.write(
        buffer,
        written,
        read.bytesRead - written,
        offset + written,
      );
      written += result.bytesWritten;
    }
    offset += read.bytesRead;
  }
}

function snapshotSuffix(path: string): string {
  const extension = extname(path).toLowerCase();
  return [".js", ".mjs", ".cjs", ".exe"].includes(extension) ? extension : "";
}

export async function createExecutableSnapshot(
  options: SnapshotOptions,
): Promise<ExecutableSnapshot> {
  assertActive(options.signal, options.deadline);
  const removeDirectory =
    options.removeDirectory ??
    ((path: string) => rm(path, { force: true, recursive: true }));
  let directory: string | undefined;
  let releaseCapacity: (() => void) | undefined;
  let source: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const sourcePath = await resolveSource(options);
    assertActive(options.signal, options.deadline);
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    source = await open(sourcePath, constants.O_RDONLY | noFollow);
    const metadata = await source.stat();
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_EXECUTABLE_SNAPSHOT_BYTES ||
      (process.platform !== "win32" && (metadata.mode & 0o111) === 0)
    ) {
      throw new ProviderError(
        "PROVIDER_UNSAFE",
        "Provider executable is not a bounded executable regular file",
      );
    }
    await validateExecutableSource(source, sourcePath, metadata.size);
    assertActive(options.signal, options.deadline);
    releaseCapacity = reserveSnapshot(metadata.size);
    if (releaseCapacity === undefined) {
      throw new ProviderError(
        "PROVIDER_CAPACITY",
        "Provider executable snapshot capacity is exhausted",
      );
    }
    directory = await mkdtemp(join(tmpdir(), ".cq-executable-"));
    await chmod(directory, 0o700);
    const createdPath = join(
      directory,
      `provider${snapshotSuffix(sourcePath)}`,
    );
    const destination = await open(createdPath, "wx", 0o500);
    try {
      await copyFixedBytes({
        source,
        destination,
        size: metadata.size,
        signal: options.signal,
        deadline: options.deadline,
      });
      await destination.chmod(0o500);
      await destination.sync();
    } finally {
      await destination.close();
    }
    const after = await source.stat();
    if (
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.ctimeMs !== metadata.ctimeMs
    ) {
      throw new ProviderError(
        "PROVIDER_UNSAFE",
        "Provider executable changed while it was snapshotted",
      );
    }
    const snapshotPath = await realpath(createdPath);
    let released = false;
    let releaseAttempt: Promise<void> | undefined;
    const ownedDirectory = directory;
    const ownedCapacity = releaseCapacity;
    directory = undefined;
    releaseCapacity = undefined;
    return Object.freeze({
      path: snapshotPath,
      sourcePath,
      size: metadata.size,
      async release(): Promise<void> {
        if (released) return;
        if (releaseAttempt !== undefined) return releaseAttempt;
        releaseAttempt = (async () => {
          try {
            await removeDirectory(ownedDirectory);
          } catch {
            throw new ProviderError(
              "PROVIDER_UNSAFE",
              "Provider executable snapshot cleanup failed",
            );
          }
          ownedCapacity();
          released = true;
        })();
        try {
          await releaseAttempt;
        } finally {
          releaseAttempt = undefined;
        }
      },
    });
  } catch (error) {
    if (directory !== undefined) {
      try {
        await removeDirectory(directory);
        releaseCapacity?.();
        releaseCapacity = undefined;
        directory = undefined;
      } catch {
        throw new ProviderError(
          "PROVIDER_UNSAFE",
          "Provider executable snapshot cleanup failed",
        );
      }
    }
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Provider executable could not be snapshotted safely",
    );
  } finally {
    await source?.close().catch(() => undefined);
    if (directory === undefined) releaseCapacity?.();
  }
}
