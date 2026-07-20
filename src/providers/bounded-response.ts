import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { ProviderError } from "./provider.js";

const READ_CHUNK_BYTES = 64 * 1024;

function assertPositiveLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ProviderError(
      "PROVIDER_CONFIG_INVALID",
      "Provider response byte limit must be a positive integer",
    );
  }
}

export async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  assertPositiveLimit(maxBytes);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ProviderError(
        "PROVIDER_UNSAFE",
        "Provider output path is not a regular file",
      );
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new ProviderError(
        "PROVIDER_UNSAFE",
        "Provider output file permissions are not private",
      );
    }
    for (;;) {
      const buffer = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, maxBytes - totalBytes + 1),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw new ProviderError(
          "PROVIDER_RESPONSE_TOO_LARGE",
          "Provider output file exceeded its hard limit",
        );
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}

export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  assertPositiveLimit(maxBytes);
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
    rejectAbort?.(signal.reason ?? new Error("Provider response was aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal.aborted) onAbort();
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        void reader
          .cancel("response byte limit exceeded")
          .catch(() => undefined);
        throw new ProviderError(
          "PROVIDER_RESPONSE_TOO_LARGE",
          "Provider response exceeded its hard limit",
        );
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      void reader.cancel(signal.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export function cancelResponseBody(response: Response, reason: string): void {
  void response.body?.cancel(reason).catch(() => undefined);
}
