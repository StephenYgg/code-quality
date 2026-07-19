import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { locksDirectory } from "./paths.js";

export interface LockHandle {
  readonly key: string;
  readonly owner: string;
  readonly path: string;
}

export class LockError extends Error {
  constructor(
    readonly code: "LOCK_BUSY" | "LOCK_NOT_OWNED" | "LOCK_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "LockError";
  }
}

export async function acquireLock(
  key: string,
  options?: {
    readonly ttlMs?: number;
    readonly env?: NodeJS.ProcessEnv;
  },
): Promise<LockHandle> {
  if (!/^[a-f0-9]{64}$/u.test(key)) {
    throw new LockError("LOCK_INVALID", "Lock key must be a sha256 hex digest");
  }
  const directory = locksDirectory(options?.env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${key}.lock`);
  const owner = randomUUID();
  const ttlMs = options?.ttlMs ?? 60_000;
  const payload = JSON.stringify({
    owner,
    expiresAt: Date.now() + ttlMs,
  });
  try {
    await writeFile(path, `${payload}\n`, { flag: "wx", mode: 0o600 });
    return { key, owner, path };
  } catch {
    try {
      const existing = JSON.parse(await readFile(path, "utf8")) as {
        readonly owner?: string;
        readonly expiresAt?: number;
      };
      if (
        typeof existing.expiresAt === "number" &&
        existing.expiresAt < Date.now()
      ) {
        await rm(path, { force: true });
        await writeFile(path, `${payload}\n`, { flag: "wx", mode: 0o600 });
        return { key, owner, path };
      }
    } catch {
      // fall through
    }
    throw new LockError("LOCK_BUSY", "Review lock is held by another owner");
  }
}

export async function releaseLock(handle: LockHandle): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(handle.path, "utf8")) as {
      readonly owner?: string;
    };
    if (existing.owner !== handle.owner) {
      throw new LockError("LOCK_NOT_OWNED", "Lock owner token mismatch");
    }
    await rm(handle.path, { force: true });
  } catch (error) {
    if (error instanceof LockError) throw error;
    // already released
  }
}
