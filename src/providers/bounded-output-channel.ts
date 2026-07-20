import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { BoundedChildError, runBoundedChild } from "./bounded-child-process.js";
import { ProviderError } from "./provider.js";

const MKFIFO_CANDIDATES = ["/usr/bin/mkfifo", "/bin/mkfifo"] as const;
const MKFIFO_OUTPUT_BYTES = 4 * 1024;
const MKFIFO_TIMEOUT_MS = 1_000;

export interface BoundedOutputChannel {
  readonly childFd: number;
  readonly stream: Readable;
  closeParentWriter(): Promise<void>;
  dispose(): Promise<void>;
}

async function resolveMkfifo(): Promise<string> {
  for (const candidate of MKFIFO_CANDIDATES) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Try the next fixed system path.
    }
  }
  throw new ProviderError(
    "PROVIDER_UNSAFE",
    "Provider output cannot be bounded because mkfifo is unavailable",
  );
}

async function createFifo(
  path: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  try {
    const result = await runBoundedChild({
      executable: await resolveMkfifo(),
      args: ["-m", "600", path],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeoutMs: Math.min(timeoutMs, MKFIFO_TIMEOUT_MS),
      maxStdoutBytes: MKFIFO_OUTPUT_BYTES,
      maxStderrBytes: MKFIFO_OUTPUT_BYTES,
      maxCombinedBytes: MKFIFO_OUTPUT_BYTES,
      signal,
    });
    if (result.exitCode !== 0) {
      throw new ProviderError(
        "PROVIDER_UNSAFE",
        "Provider output FIFO creation failed",
      );
    }
    const metadata = await lstat(path);
    if (!metadata.isFIFO() || (metadata.mode & 0o777) !== 0o600) {
      throw new ProviderError(
        "PROVIDER_UNSAFE",
        "Provider output FIFO validation failed",
      );
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof BoundedChildError) {
      if (error.reason === "aborted") {
        throw new ProviderError(
          "PROVIDER_ABORTED",
          "Provider call was cancelled",
        );
      }
      if (error.reason === "timeout") {
        throw new ProviderError("PROVIDER_TIMEOUT", "Provider call timed out");
      }
    }
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Provider output FIFO creation failed",
    );
  }
}

async function closeHandle(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined);
}

export async function createBoundedOutputChannel(options: {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}): Promise<BoundedOutputChannel> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Provider last-message output cannot be bounded on this platform",
    );
  }
  if (options.signal.aborted) {
    throw new ProviderError("PROVIDER_ABORTED", "Provider call was cancelled");
  }
  if (options.timeoutMs <= 0) {
    throw new ProviderError("PROVIDER_TIMEOUT", "Provider call timed out");
  }
  const path = join(options.workspace, ".last-message-fifo");
  let keeper: FileHandle | undefined;
  let reader: FileHandle | undefined;
  let writer: FileHandle | undefined;
  try {
    await createFifo(path, options.signal, options.timeoutMs);
    keeper = await open(path, constants.O_RDWR);
    reader = await open(path, constants.O_RDONLY);
    writer = await open(path, constants.O_WRONLY);
    await rm(path);
    await closeHandle(keeper);
    keeper = undefined;
    const ownedReader = reader;
    const ownedWriter = writer;
    const stream = ownedReader.createReadStream({ autoClose: false });
    let disposed = false;
    let writerClosed = false;
    reader = undefined;
    writer = undefined;
    return Object.freeze({
      childFd: ownedWriter.fd,
      stream,
      async closeParentWriter(): Promise<void> {
        if (writerClosed) return;
        writerClosed = true;
        await closeHandle(ownedWriter);
      },
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        stream.destroy();
        await Promise.all([closeHandle(ownedWriter), closeHandle(ownedReader)]);
      },
    });
  } catch (error) {
    await Promise.all([
      closeHandle(writer),
      closeHandle(reader),
      closeHandle(keeper),
      rm(path, { force: true }).catch(() => undefined),
    ]);
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Provider output channel could not be created safely",
    );
  }
}
