import { constants, type BigIntStats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";

export const MAX_BOUNDED_FILE_BYTES = 64 * 1024 * 1024;

export type BoundedFileErrorCode =
  "FILE_CHANGED" | "FILE_LIMIT_EXCEEDED" | "INVALID_UTF8" | "READ_FAILED";

export class BoundedFileReadError extends Error {
  constructor(
    readonly code: BoundedFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BoundedFileReadError";
  }
}

export interface BoundedFileIo {
  readonly realpath: (path: string) => Promise<string>;
  readonly open: (path: string, flags: number) => Promise<FileHandle>;
  readonly stat: (
    path: string,
    options: { readonly bigint: true },
  ) => Promise<BigIntStats>;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
}

const DEFAULT_IO: BoundedFileIo = {
  realpath: async (path) => realpath(path),
  open: async (path, flags) => open(path, flags),
  stat: async (path, options) => stat(path, options),
};

function identityOf(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    ctimeNs: stats.ctimeNs,
    mtimeNs: stats.mtimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

async function captureIdentity(handle: FileHandle): Promise<FileIdentity> {
  const opened = await handle.stat({ bigint: true });
  if (!opened.isFile()) {
    throw new BoundedFileReadError(
      "READ_FAILED",
      "Input is not a regular file",
    );
  }
  return identityOf(opened);
}

async function verifyIdentity(
  requestedPath: string,
  resolvedPath: string,
  handle: FileHandle,
  expected: FileIdentity,
  io: BoundedFileIo,
): Promise<void> {
  const [currentResolvedPath, descriptorStats, pathnameStats] =
    await Promise.all([
      io.realpath(requestedPath),
      handle.stat({ bigint: true }),
      io.stat(resolvedPath, { bigint: true }),
    ]);
  if (
    currentResolvedPath !== resolvedPath ||
    !descriptorStats.isFile() ||
    !pathnameStats.isFile() ||
    !sameIdentity(identityOf(descriptorStats), expected) ||
    !sameIdentity(identityOf(pathnameStats), expected)
  ) {
    throw new BoundedFileReadError(
      "FILE_CHANGED",
      "Input file changed while it was being read",
    );
  }
}

async function readAtMost(
  handle: FileHandle,
  maximumBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.length - total,
      total,
    );
    if (bytesRead === 0) break;
    if (bytesRead < 0 || bytesRead > buffer.length - total) {
      throw new BoundedFileReadError(
        "READ_FAILED",
        "Input reader returned an invalid byte count",
      );
    }
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

function validateMaximumBytes(maximumBytes: number): void {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_BOUNDED_FILE_BYTES
  ) {
    throw new RangeError(
      `maximumBytes must be an integer from 1 to ${MAX_BOUNDED_FILE_BYTES.toString()}`,
    );
  }
}

function decodeUtf8(content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new BoundedFileReadError(
      "INVALID_UTF8",
      "Input file is not valid UTF-8",
    );
  }
}

export async function readBoundedUtf8File(
  path: string,
  maximumBytes: number,
  io: BoundedFileIo = DEFAULT_IO,
): Promise<string> {
  validateMaximumBytes(maximumBytes);
  let handle: FileHandle | undefined;
  let result: string | undefined;
  let primaryError: BoundedFileReadError | RangeError | undefined;
  try {
    const resolvedPath = await io.realpath(path);
    handle = await io.open(
      resolvedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const openedIdentity = await captureIdentity(handle);
    await verifyIdentity(path, resolvedPath, handle, openedIdentity, io);
    if (openedIdentity.size > BigInt(maximumBytes)) {
      throw new BoundedFileReadError(
        "FILE_LIMIT_EXCEEDED",
        `Input exceeds the ${maximumBytes.toString()} byte limit`,
      );
    }
    const content = await readAtMost(handle, maximumBytes);
    await verifyIdentity(path, resolvedPath, handle, openedIdentity, io);
    if (content.length > maximumBytes) {
      throw new BoundedFileReadError(
        "FILE_LIMIT_EXCEEDED",
        `Input exceeds the ${maximumBytes.toString()} byte limit`,
      );
    }
    result = decodeUtf8(content);
  } catch (error) {
    primaryError =
      error instanceof BoundedFileReadError || error instanceof RangeError
        ? error
        : new BoundedFileReadError(
            "READ_FAILED",
            "Input file could not be read",
          );
  }
  let closeFailed = false;
  try {
    await handle?.close();
  } catch {
    closeFailed = true;
  }
  if (primaryError !== undefined) throw primaryError;
  if (closeFailed) {
    throw new BoundedFileReadError(
      "READ_FAILED",
      "Input file could not be closed safely",
    );
  }
  if (result === undefined) {
    throw new BoundedFileReadError(
      "READ_FAILED",
      "Input file read did not produce a result",
    );
  }
  return result;
}
