import { createHash } from "node:crypto";

import {
  CacheCapacityError,
  publishCacheEntry,
  readCacheEntry,
} from "../storage/cache.js";
import {
  acquireLock,
  type LockHandle,
  LockError,
  isLockActive,
  releaseLock,
  renewLock,
} from "../storage/locks.js";
import { RunStorageError, type StoredRunRecord } from "../storage/runs.js";
import type { ReviewRunResult } from "./orchestrator.js";
import { PROMPT_BUNDLE_VERSION } from "./prompts.js";

export const MAX_LOCAL_WAITERS_PER_KEY = 64;
export const MAX_SINGLE_FLIGHT_WAIT_MS = 60_000;

export type SingleFlightIncompleteCode =
  | "RUN_STORAGE_CAPACITY_EXCEEDED"
  | "CACHE_CAPACITY_EXCEEDED"
  | "SINGLE_FLIGHT_RESULT_UNAVAILABLE"
  | "SINGLE_FLIGHT_WAITER_LIMIT"
  | "SINGLE_FLIGHT_TIMEOUT";

export function buildReviewCacheKey(parts: {
  readonly repositoryIdentity: string;
  readonly contentHash: string;
  readonly contentBundleHash: string;
  readonly providerName: string;
  readonly model: string;
  readonly policyHash: string;
  readonly reviewMode?: "review" | "score";
  readonly scoreModelFingerprint?: string;
  readonly promptBundleVersion?: string;
  /** Hook or review execution preset (balanced/strict/fast/full). */
  readonly preset?: string;
  readonly adapterVersion?: string;
}): string {
  const reviewMode = parts.reviewMode ?? "review";
  if (
    reviewMode === "score" &&
    !/^[a-f0-9]{64}$/u.test(parts.scoreModelFingerprint ?? "")
  ) {
    throw new TypeError("Score cache keys require a SHA-256 model fingerprint");
  }
  if (reviewMode === "review" && parts.scoreModelFingerprint !== undefined) {
    throw new TypeError("Ordinary review cache keys cannot bind a score model");
  }
  return createHash("sha256")
    .update("cq-review-single-flight:v4\0")
    .update(parts.repositoryIdentity)
    .update("\0")
    .update(parts.contentHash)
    .update("\0")
    .update(parts.contentBundleHash)
    .update("\0")
    .update(parts.providerName)
    .update("\0")
    .update(parts.model)
    .update("\0")
    .update(parts.policyHash)
    .update("\0")
    .update(reviewMode)
    .update("\0")
    .update(parts.scoreModelFingerprint ?? "none")
    .update("\0")
    .update(parts.promptBundleVersion ?? PROMPT_BUNDLE_VERSION)
    .update("\0")
    .update(parts.preset ?? "full")
    .update("\0")
    .update(parts.adapterVersion ?? "none")
    .digest("hex");
}

export async function runWithSingleFlight(options: {
  readonly key: string;
  readonly contentBundleHash: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly signal?: AbortSignal;
  readonly random?: () => number;
  readonly run: () => Promise<ReviewRunResult>;
  readonly persistResult?: (result: ReviewRunResult) => Promise<void>;
  readonly toRecord: (result: ReviewRunResult) => StoredRunRecord;
}): Promise<
  | { readonly kind: "executed"; readonly result: ReviewRunResult }
  | { readonly kind: "cached"; readonly record: StoredRunRecord }
  | {
      readonly kind: "incomplete";
      readonly reason: string;
      readonly code: SingleFlightIncompleteCode;
    }
> {
  options.signal?.throwIfAborted();
  const waitMs = boundedWaitMs(options.waitMs ?? 30_000);
  const pollMs = options.pollMs ?? 200;
  const leaseMs = options.leaseMs ?? Math.max(waitMs, 60_000);
  validateTiming(waitMs, pollMs, leaseMs);
  const cached = await readCacheEntry(options.key, options.env, {
    expectedContentBundleHash: options.contentBundleHash,
  });
  if (cached !== undefined) {
    return { kind: "cached", record: cached };
  }

  let lock: LockHandle | undefined;
  try {
    lock = await acquireLock(options.key, {
      ttlMs: leaseMs,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } catch (error) {
    if (!(error instanceof LockError) || error.code !== "LOCK_BUSY") {
      throw error;
    }
  }
  if (lock !== undefined) return executeAsWinner(options, lock, leaseMs);

  const waiterSlot = await acquireWaiterSlot(
    options.key,
    options.env,
    waitMs,
    options.signal,
  );
  if (waiterSlot === undefined) {
    return {
      kind: "incomplete",
      reason: `Local-host single-flight waiter limit of ${MAX_LOCAL_WAITERS_PER_KEY.toString()} reached for this key`,
      code: "SINGLE_FLIGHT_WAITER_LIMIT",
    };
  }
  try {
    return await waitForCachedResult(options, waitMs, pollMs);
  } finally {
    await releaseLock(waiterSlot);
  }
}

async function waitForCachedResult(
  options: {
    readonly key: string;
    readonly contentBundleHash: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly random?: () => number;
  },
  waitMs: number,
  pollMs: number,
) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const waited = await readCacheEntry(options.key, options.env, {
      expectedContentBundleHash: options.contentBundleHash,
    });
    if (waited !== undefined) {
      return { kind: "cached" as const, record: waited };
    }
    const active = await isLockActive(options.key, {
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (!active) {
      const completed = await readCacheEntry(options.key, options.env, {
        expectedContentBundleHash: options.contentBundleHash,
      });
      if (completed !== undefined) {
        return { kind: "cached" as const, record: completed };
      }
      return {
        kind: "incomplete" as const,
        reason:
          "Single-flight winner exited without publishing a reusable result",
        code: "SINGLE_FLIGHT_RESULT_UNAVAILABLE" as const,
      };
    }
    const delay = jitteredDelay(pollMs, options.random ?? Math.random);
    await sleep(
      Math.min(delay, Math.max(1, deadline - Date.now())),
      options.signal,
    );
  }
  return {
    kind: "incomplete" as const,
    reason:
      "Another review holds the single-flight lock and no cached result became available before the wait budget expired",
    code: "SINGLE_FLIGHT_TIMEOUT" as const,
  };
}

async function acquireWaiterSlot(
  key: string,
  env: NodeJS.ProcessEnv | undefined,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<LockHandle | undefined> {
  const start = process.pid % MAX_LOCAL_WAITERS_PER_KEY;
  for (let offset = 0; offset < MAX_LOCAL_WAITERS_PER_KEY; offset += 1) {
    signal?.throwIfAborted();
    const index = (start + offset) % MAX_LOCAL_WAITERS_PER_KEY;
    try {
      return await acquireLock(waiterSlotKey(key, index), {
        ttlMs: Math.max(1, waitMs),
        ...(env === undefined ? {} : { env }),
      });
    } catch (error) {
      if (!(error instanceof LockError) || error.code !== "LOCK_BUSY") {
        throw error;
      }
    }
  }
  return undefined;
}

function waiterSlotKey(key: string, index: number): string {
  return createHash("sha256")
    .update("cq-review-waiter-slot:v1\0")
    .update(key)
    .update("\0")
    .update(index.toString())
    .digest("hex");
}

async function executeAsWinner(
  options: {
    readonly key: string;
    readonly contentBundleHash: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly run: () => Promise<ReviewRunResult>;
    readonly persistResult?: (result: ReviewRunResult) => Promise<void>;
    readonly toRecord: (result: ReviewRunResult) => StoredRunRecord;
  },
  lock: LockHandle,
  leaseMs: number,
) {
  const controller = new AbortController();
  let heartbeatError: Error | undefined;
  const heartbeat = maintainLease(lock, leaseMs, controller.signal).catch(
    (error: unknown) => {
      heartbeatError = toError(error, "Lock lease heartbeat failed");
    },
  );
  let outcome:
    | { readonly kind: "executed"; readonly result: ReviewRunResult }
    | { readonly kind: "cached"; readonly record: StoredRunRecord }
    | undefined;
  let operationError: Error | undefined;
  try {
    outcome = await executeOwnedReview(options, () => heartbeatError);
  } catch (error) {
    operationError = toError(error, "Single-flight winner failed");
  }
  controller.abort();
  await heartbeat;
  const releaseError = await releaseOwnedLock(lock);
  if (heartbeatError !== undefined) throw heartbeatError;
  if (releaseError !== undefined) throw releaseError;
  if (operationError instanceof RunStorageError) {
    return {
      kind: "incomplete" as const,
      reason: `${operationError.message}; result cannot be retrieved with cq report`,
      code: operationError.code,
    };
  }
  if (operationError instanceof CacheCapacityError) {
    return {
      kind: "incomplete" as const,
      reason: operationError.message,
      code: operationError.code,
    };
  }
  if (operationError !== undefined) throw operationError;
  if (outcome === undefined)
    throw new Error("Single-flight winner has no result");
  return outcome;
}

async function executeOwnedReview(
  options: {
    readonly key: string;
    readonly contentBundleHash: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly run: () => Promise<ReviewRunResult>;
    readonly persistResult?: (result: ReviewRunResult) => Promise<void>;
    readonly toRecord: (result: ReviewRunResult) => StoredRunRecord;
  },
  heartbeatError: () => Error | undefined,
) {
  const cached = await readCacheEntry(options.key, options.env, {
    expectedContentBundleHash: options.contentBundleHash,
  });
  if (cached !== undefined) return { kind: "cached" as const, record: cached };
  const result = await options.run();
  if (result.contentBundleHash !== options.contentBundleHash) {
    throw new Error("Review result content bundle hash is incoherent");
  }
  const renewalFailure = heartbeatError();
  if (renewalFailure !== undefined) throw renewalFailure;
  await options.persistResult?.(result);
  const postPersistenceRenewalFailure = heartbeatError();
  if (postPersistenceRenewalFailure !== undefined) {
    throw postPersistenceRenewalFailure;
  }
  if (isCacheableResult(result)) {
    await publishCacheEntry(
      options.key,
      options.toRecord(result),
      options.env,
      {
        expectedContentBundleHash: options.contentBundleHash,
      },
    );
  }
  return { kind: "executed" as const, result };
}

function isCacheableResult(result: ReviewRunResult): boolean {
  return (
    !result.incomplete &&
    result.gate !== "INCOMPLETE" &&
    result.scoreGate !== "INCOMPLETE" &&
    result.diagnostics?.some((item) => item.code.startsWith("PROVIDER_")) !==
      true
  );
}

async function releaseOwnedLock(
  handle: LockHandle,
): Promise<Error | undefined> {
  try {
    await releaseLock(handle);
    return undefined;
  } catch (error) {
    return toError(error, "Review lock release failed");
  }
}

async function maintainLease(
  handle: LockHandle,
  leaseMs: number,
  signal: AbortSignal,
): Promise<void> {
  const interval = Math.max(5, Math.floor(leaseMs / 3));
  for (;;) {
    try {
      await sleep(interval, signal);
    } catch (error) {
      if (signal.aborted) return;
      throw toError(error, "Lock lease heartbeat wait failed");
    }
    if (signal.aborted) return;
    await renewLock(handle, leaseMs);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(toError(signal?.reason, "Operation was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

function toError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message);
}

function jitteredDelay(pollMs: number, random: () => number): number {
  const sample = Math.min(1, Math.max(0, random()));
  return Math.max(1, Math.round(pollMs * (0.75 + sample * 0.5)));
}

function validateTiming(waitMs: number, pollMs: number, leaseMs: number): void {
  if (
    !Number.isSafeInteger(waitMs) ||
    waitMs < 0 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1 ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1
  ) {
    throw new RangeError("Single-flight timing values are invalid");
  }
}

function boundedWaitMs(waitMs: number): number {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
    throw new RangeError("Single-flight wait must be a non-negative integer");
  }
  return Math.min(waitMs, MAX_SINGLE_FLIGHT_WAIT_MS);
}
