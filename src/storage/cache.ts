import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, opendir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readBoundedUtf8File } from "../core/bounded-file.js";
import { isContentKey, isSchemaValidRecord } from "./cache-record.js";
import { acquireLock, LockError, releaseLock } from "./locks.js";
import { cacheEntriesDirectory } from "./paths.js";
import type { StoredRunRecord } from "./runs.js";

export interface CacheLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  readonly maxAgeMs: number;
  readonly maxCleanupEntries: number;
}

export const DEFAULT_CACHE_LIMITS: CacheLimits = Object.freeze({
  maxEntries: 256,
  maxBytes: 128 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxCleanupEntries: 32,
});

export class CacheCapacityError extends Error {
  readonly code = "CACHE_CAPACITY_EXCEEDED" as const;

  constructor(message: string) {
    super(message);
    this.name = "CacheCapacityError";
  }
}

interface CacheOptions {
  readonly limits?: CacheLimits;
  readonly now?: () => number;
  readonly expectedContentBundleHash?: string;
}

interface ResolvedCacheOptions {
  readonly limits: CacheLimits;
  readonly now: number;
  readonly expectedContentBundleHash?: string;
}

function resolveCacheOptions(
  options: CacheOptions | undefined,
): ResolvedCacheOptions {
  return {
    limits: options?.limits ?? DEFAULT_CACHE_LIMITS,
    now: options?.now?.() ?? Date.now(),
    ...(options?.expectedContentBundleHash === undefined
      ? {}
      : { expectedContentBundleHash: options.expectedContentBundleHash }),
  };
}

interface CacheFile {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAt: number;
  readonly cleanupArtifact: boolean;
}

interface CacheGeneration {
  readonly device: number;
  readonly inode: number;
  readonly bytes: number;
  readonly modifiedAt: number;
}

function assertCacheRecordContent(
  record: StoredRunRecord,
  expectedContentBundleHash: string | undefined,
): void {
  if (!isContentKey(record.contentBundleHash)) {
    throw new Error(
      "Cache record content bundle hash is invalid or incoherent",
    );
  }
  if (record.contentBundleHash !== record.runDocument.input.contentBundleHash) {
    throw new Error(
      "Cache record content bundle hash is invalid or incoherent",
    );
  }
  if (
    expectedContentBundleHash !== undefined &&
    record.contentBundleHash !== expectedContentBundleHash
  ) {
    throw new Error(
      "Cache record content bundle hash is invalid or incoherent",
    );
  }
}

export async function publishCacheEntry(
  key: string,
  record: StoredRunRecord,
  env?: NodeJS.ProcessEnv,
  options?: CacheOptions,
): Promise<void> {
  const resolved = resolveCacheOptions(options);
  if (!isContentKey(key))
    throw new Error("Cache key must be a sha256 hex digest");
  assertCacheRecordContent(record, resolved.expectedContentBundleHash);
  const limits = resolved.limits;
  validateLimits(limits);
  const directory = cacheEntriesDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(withCacheKey(record, key))}\n`;
  const bytes = Buffer.byteLength(body);
  if (bytes > limits.maxEntryBytes || bytes > limits.maxBytes) {
    throw new CacheCapacityError(
      "Cache entry exceeds the configured byte capacity",
    );
  }

  const guard = await acquireMaintenanceLock(directory);
  if (guard === undefined) {
    throw new CacheCapacityError(
      "Cache maintenance capacity is temporarily unavailable",
    );
  }
  try {
    const canWrite = await makeCapacity(
      directory,
      key,
      bytes,
      limits,
      resolved.now,
    );
    if (!canWrite) {
      throw new CacheCapacityError(
        "Cache capacity could not be restored within cleanup limits",
      );
    }
    await atomicWrite(join(directory, `${key}.json`), body);
  } finally {
    await releaseLock(guard);
  }
}

export async function readCacheEntry(
  key: string,
  env?: NodeJS.ProcessEnv,
  options?: CacheOptions,
): Promise<StoredRunRecord | undefined> {
  if (!isContentKey(key)) return undefined;
  const resolved = resolveCacheOptions(options);
  const limits = resolved.limits;
  validateLimits(limits);
  const directory = cacheEntriesDirectory(env);
  const path = join(directory, `${key}.json`);
  const now = resolved.now;
  let observedGeneration: CacheGeneration | undefined;
  try {
    const metadata = await lstat(path);
    observedGeneration = cacheGeneration(metadata);
    if (!isUsableCacheFile(metadata, limits, now)) {
      await discardCacheGeneration(
        directory,
        path,
        observedGeneration,
        key,
        limits,
        now,
        resolved.expectedContentBundleHash,
      );
      return undefined;
    }
    const parsed = JSON.parse(
      await readBoundedUtf8File(path, limits.maxEntryBytes),
    ) as unknown;
    if (isSchemaValidRecord(parsed, key, resolved.expectedContentBundleHash)) {
      return parsed;
    }
    await discardCacheGeneration(
      directory,
      path,
      observedGeneration,
      key,
      limits,
      now,
      resolved.expectedContentBundleHash,
    );
    return undefined;
  } catch {
    if (observedGeneration !== undefined) {
      await discardCacheGeneration(
        directory,
        path,
        observedGeneration,
        key,
        limits,
        now,
        resolved.expectedContentBundleHash,
      );
    }
    return undefined;
  }
}

export async function deleteCacheEntry(
  key: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (!isContentKey(key)) return;
  await rm(join(cacheEntriesDirectory(env), `${key}.json`), { force: true });
}

async function makeCapacity(
  directory: string,
  key: string,
  incomingBytes: number,
  limits: CacheLimits,
  now: number,
): Promise<boolean> {
  const { files, overflow } = await scanCache(directory, limits);
  const targetName = `${key}.json`;
  const existing = files.find((file) => file.name === targetName);
  let entries = files.length - (existing === undefined ? 0 : 1) + 1;
  let bytes =
    files.reduce((sum, file) => sum + file.bytes, 0) -
    (existing?.bytes ?? 0) +
    incomingBytes;
  const candidates = files
    .filter((file) => file.name !== targetName)
    .sort((left, right) => left.modifiedAt - right.modifiedAt);
  let removed = 0;
  for (const candidate of candidates) {
    const cacheEntry = candidate.name.endsWith(".json");
    const expired = cacheEntry && now - candidate.modifiedAt > limits.maxAgeMs;
    const overCapacity =
      entries > limits.maxEntries || bytes > limits.maxBytes || overflow;
    const removable =
      candidate.cleanupArtifact || (cacheEntry && (expired || overCapacity));
    if (!removable || removed >= limits.maxCleanupEntries) {
      continue;
    }
    await rm(candidate.path, { force: true });
    entries -= 1;
    bytes -= candidate.bytes;
    removed += 1;
  }
  return !overflow && entries <= limits.maxEntries && bytes <= limits.maxBytes;
}

async function scanCache(
  directory: string,
  limits: CacheLimits,
): Promise<{
  readonly files: readonly CacheFile[];
  readonly overflow: boolean;
}> {
  const scanLimit = limits.maxEntries + limits.maxCleanupEntries + 1;
  const files: CacheFile[] = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (!entry.isFile()) continue;
    if (files.length >= scanLimit) return { files, overflow: true };
    const path = join(directory, entry.name);
    try {
      const metadata = await lstat(path);
      if (metadata.isFile()) {
        files.push({
          name: entry.name,
          path,
          bytes: metadata.size,
          modifiedAt: metadata.mtimeMs,
          cleanupArtifact: isCacheCleanupArtifact(entry.name),
        });
      }
    } catch {
      // A concurrent delete does not consume cleanup capacity.
    }
  }
  return { files, overflow: false };
}

function isCacheCleanupArtifact(name: string): boolean {
  return /^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.(?:tmp|quarantine)$/u.test(name);
}

async function acquireMaintenanceLock(directory: string, waitMs = 2_000) {
  const key = createHash("sha256")
    .update("cq-cache-maintenance:v1\0")
    .update(directory)
    .digest("hex");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await acquireLock(key, {
        ttlMs: 10_000,
        env: { CQ_STATE_DIR: directory },
      });
    } catch (error) {
      if (!(error instanceof LockError) || error.code !== "LOCK_BUSY")
        throw error;
      if (Date.now() >= deadline) return undefined;
      await delay(5 + Math.floor(Math.random() * 11));
    }
  }
}

async function atomicWrite(path: string, body: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function discardCacheGeneration(
  directory: string,
  path: string,
  observed: CacheGeneration,
  key: string,
  limits: CacheLimits,
  now: number,
  expectedContentBundleHash?: string,
): Promise<void> {
  const guard = await acquireMaintenanceLock(directory, 0);
  if (guard === undefined) return;
  try {
    const current = await lstat(path);
    if (
      !current.isFile() ||
      !sameCacheGeneration(observed, cacheGeneration(current))
    ) {
      return;
    }
    if (isUsableCacheFile(current, limits, now)) {
      try {
        const parsed = JSON.parse(
          await readBoundedUtf8File(path, limits.maxEntryBytes),
        ) as unknown;
        if (isSchemaValidRecord(parsed, key, expectedContentBundleHash)) return;
      } catch {
        // The observed generation remains a cleanup candidate.
      }
    }
    const beforeRename = await lstat(path);
    if (!sameCacheGeneration(observed, cacheGeneration(beforeRename))) return;
    const quarantine = `${path}.${randomUUID()}.quarantine`;
    await rename(path, quarantine);
    await rm(quarantine, { force: true });
  } catch {
    // Cache cleanup is best effort; misses remain safe and retryable.
  } finally {
    try {
      await releaseLock(guard);
    } catch {
      // A failed release remains bounded by lock-owner reclamation.
    }
  }
}

function isUsableCacheFile(
  metadata: Stats,
  limits: CacheLimits,
  now: number,
): boolean {
  return (
    metadata.isFile() &&
    metadata.size <= limits.maxEntryBytes &&
    now - metadata.mtimeMs <= limits.maxAgeMs
  );
}

function cacheGeneration(metadata: Stats): CacheGeneration {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    bytes: metadata.size,
    modifiedAt: metadata.mtimeMs,
  };
}

function sameCacheGeneration(
  left: CacheGeneration,
  right: CacheGeneration,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.bytes === right.bytes &&
    left.modifiedAt === right.modifiedAt
  );
}

function withCacheKey(record: StoredRunRecord, key: string): StoredRunRecord {
  return {
    ...record,
    cacheKey: key,
    runDocument: {
      ...record.runDocument,
      reproducibility: {
        ...record.runDocument.reproducibility,
        cacheKey: key,
      },
    },
  };
}

function validateLimits(limits: CacheLimits): void {
  const integers = [
    limits.maxEntries,
    limits.maxBytes,
    limits.maxEntryBytes,
    limits.maxAgeMs,
    limits.maxCleanupEntries,
  ];
  if (
    integers.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    limits.maxEntryBytes > limits.maxBytes
  ) {
    throw new RangeError("Cache limits must be positive safe integers");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
