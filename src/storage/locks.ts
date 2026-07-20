import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  ensureGlobalLockCapacity,
  LOCK_MAINTENANCE_DIRECTORY,
  LOCK_ARTIFACT_GRACE_MS,
  MAX_LOCK_ARTIFACTS_PER_CONTAINER,
  MAX_LOCK_CLEANUP_PER_ACQUIRE,
  MAX_LOCK_CONTAINERS,
  reserveLockArtifacts,
} from "./lock-artifacts.js";
import {
  acquireGenerationGuard,
  canReclaimGuard,
  canReclaimLock,
  generationGuardPreparation,
  GUARD_FILE,
  type GuardPreparation,
  type GuardHandle,
  type LockHandle,
  LockError,
  type LockPayload,
  newGuardPayload,
  newLockPayload,
  type ObservedLock,
  ownerPreparationPath,
  ownerPath,
  quarantinePath,
  readGuardPayload,
  readObservedLock,
  releaseGenerationGuard,
  replaceLockPayload,
  jsonBody,
  tryCreateOwner,
} from "./lock-lease.js";
import {
  localHost,
  type LockDirectoryRename,
  safeLstat,
  tryMkdir,
  tryRenameDirectory,
} from "./lock-platform.js";
import { locksDirectory } from "./paths.js";

export {
  LOCK_ARTIFACT_GRACE_MS,
  MAX_LOCK_ARTIFACTS_PER_CONTAINER,
  MAX_LOCK_CLEANUP_PER_ACQUIRE,
  MAX_LOCK_CONTAINERS,
  LockError,
};
export type { LockDirectoryRename, LockHandle };

export type LockLifecyclePhase =
  | "owner-observed"
  | "generation-guard-acquired"
  | "owner-quarantined"
  | "owner-installed";

export type LockLifecycleBarrier = (phase: LockLifecyclePhase) => Promise<void>;

export async function acquireLock(
  key: string,
  options?: {
    readonly ttlMs?: number;
    readonly env?: NodeJS.ProcessEnv;
    readonly directoryRename?: LockDirectoryRename;
    readonly lifecycleBarrier?: LockLifecycleBarrier;
  },
): Promise<LockHandle> {
  validateKey(key);
  const ttlMs = options?.ttlMs ?? 60_000;
  validateTtl(ttlMs);
  const directory = locksDirectory(options?.env);
  const root = join(directory, `${key}.lock`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const payload = newLockPayload(ttlMs);
  const existing = await readObservedLock(root);
  if (existing !== undefined) {
    if (!canReclaimLock(existing.payload)) throw busy();
    await options?.lifecycleBarrier?.("owner-observed");
    return reclaimDeadOwner(
      key,
      root,
      existing,
      payload,
      options?.directoryRename,
      false,
      options?.lifecycleBarrier,
    );
  }
  const maintenance = await acquireDirectoryMaintenance(directory);
  if (maintenance === undefined) throw busy();
  try {
    const current = await readObservedLock(root);
    if (current !== undefined) {
      if (!canReclaimLock(current.payload)) throw busy();
      return await reclaimDeadOwner(
        key,
        root,
        current,
        payload,
        options?.directoryRename,
        true,
        options?.lifecycleBarrier,
      );
    }
    const directoryReady = await ensureLockContainer(root, directory);
    if (directoryReady) {
      const prepared = ownerPreparationPath(root, payload);
      await reserveLockArtifacts(root, [prepared]);
      const acquired = await tryCreateOwner(
        key,
        root,
        payload,
        prepared,
        options?.directoryRename,
      );
      if (acquired !== undefined) return acquired;
    }

    const observed = await readObservedLock(root);
    if (observed === undefined || !canReclaimLock(observed.payload)) {
      throw busy();
    }
    return await reclaimDeadOwner(
      key,
      root,
      observed,
      payload,
      options?.directoryRename,
      true,
      options?.lifecycleBarrier,
    );
  } finally {
    await releaseGenerationGuard(maintenance);
  }
}

export async function isLockActive(
  key: string,
  options?: { readonly env?: NodeJS.ProcessEnv },
): Promise<boolean> {
  validateKey(key);
  const root = join(locksDirectory(options?.env), `${key}.lock`);
  const observed = await readObservedLock(root);
  return observed !== undefined && !canReclaimLock(observed.payload);
}

export async function releaseLock(handle: LockHandle): Promise<void> {
  const observed = await readObservedLock(handle.path);
  if (observed === undefined) return;
  assertOwner(handle, observed.payload);
  const preparation = await reserveGenerationArtifact(handle.path, observed);
  const guard = await acquireGenerationGuard(
    handle.path,
    observed,
    preparation,
    handle.directoryRename,
  );
  if (guard === undefined) throw busy();
  let retiredOwner: string | undefined;
  try {
    const current = await readObservedLock(handle.path);
    if (current === undefined) return;
    assertOwner(handle, current.payload);
    retiredOwner = quarantinePath(handle.path, current);
    await (handle.directoryRename ?? rename)(
      ownerPath(handle.path, current.kind),
      retiredOwner,
    );
  } finally {
    if (retiredOwner !== undefined) {
      await rm(retiredOwner, { force: true, recursive: true });
    }
    await releaseGenerationGuard(guard);
    await removeEmptyContainer(handle.path);
  }
}

export async function renewLock(
  handle: LockHandle,
  ttlMs = 60_000,
): Promise<void> {
  validateTtl(ttlMs);
  const observed = await readObservedLock(handle.path);
  if (observed === undefined) throw notOwned();
  assertOwner(handle, observed.payload);
  const preparation = await reserveGenerationArtifact(handle.path, observed);
  const guard = await acquireGenerationGuard(
    handle.path,
    observed,
    preparation,
    handle.directoryRename,
  );
  if (guard === undefined) throw busy();
  try {
    const current = await readObservedLock(handle.path);
    if (current === undefined) throw notOwned();
    assertOwner(handle, current.payload);
    await replaceLockPayload(handle.path, {
      ...current.payload,
      expiresAt: Date.now() + ttlMs,
    });
  } finally {
    await releaseGenerationGuard(guard);
  }
}

async function acquireDirectoryMaintenance(
  directory: string,
): Promise<GuardHandle | undefined> {
  const path = join(directory, LOCK_MAINTENANCE_DIRECTORY);
  const deadline = Date.now() + 2_000;
  for (;;) {
    const payload = newGuardPayload("lock-directory-maintenance");
    if (await tryMkdir(path)) {
      try {
        await writeFile(join(path, GUARD_FILE), jsonBody(payload), {
          flag: "wx",
          mode: 0o600,
        });
        return { path, token: payload.token };
      } catch (error) {
        await rm(path, { force: true, recursive: true });
        throw error;
      }
    }
    const existing = await readGuardPayload(path);
    const metadata = await safeLstat(path);
    const reclaimable =
      (existing !== undefined && canReclaimGuard(existing)) ||
      (existing === undefined &&
        metadata !== undefined &&
        isPastArtifactGrace(metadata.mtimeMs));
    if (reclaimable) {
      const quarantine = `${path}.quarantine-${randomUUID()}`;
      if (await tryRenameDirectory(path, quarantine)) {
        await rm(quarantine, { force: true, recursive: true });
        continue;
      }
    }
    if (
      existing !== undefined &&
      existing.host !== localHost() &&
      !canReclaimGuard(existing)
    ) {
      return undefined;
    }
    if (Date.now() >= deadline) return undefined;
    await delay(2);
  }
}

async function reclaimDeadOwner(
  key: string,
  root: string,
  observed: ObservedLock,
  payload: LockPayload,
  directoryRename?: LockDirectoryRename,
  maintenanceHeld = false,
  lifecycleBarrier?: LockLifecycleBarrier,
): Promise<LockHandle> {
  const maintenance = maintenanceHeld
    ? undefined
    : await acquireDirectoryMaintenance(dirname(root));
  if (!maintenanceHeld && maintenance === undefined) throw busy();
  const guardPreparation = generationGuardPreparation(root, observed);
  let ownerPreparation: string | undefined;
  let quarantine: string | undefined;
  try {
    if (observed.kind === "directory") {
      ownerPreparation = ownerPreparationPath(root, payload);
      await reserveLockArtifacts(root, [
        guardPreparation.path,
        ownerPreparation,
      ]);
    } else {
      if (
        !(await ensureGlobalLockCapacity(
          dirname(root),
          basename(guardPreparation.path),
        ))
      ) {
        throw capacityExceeded();
      }
      await mkdir(guardPreparation.path, { mode: 0o700 });
    }
    const guard = await acquireGenerationGuard(
      root,
      observed,
      guardPreparation,
      directoryRename,
    );
    if (guard === undefined) throw busy();
    try {
      const current = await readObservedLock(root);
      if (
        current === undefined ||
        current.payload.owner !== observed.payload.owner ||
        !canReclaimLock(current.payload)
      ) {
        throw busy();
      }
      await lifecycleBarrier?.("generation-guard-acquired");
      quarantine = quarantinePath(root, current);
      await (directoryRename ?? rename)(
        ownerPath(root, current.kind),
        quarantine,
      );
      await lifecycleBarrier?.("owner-quarantined");
      await ensureLockContainer(root, dirname(root));
      ownerPreparation ??= ownerPreparationPath(root, payload);
      if (observed.kind === "legacy-file") {
        await reserveLockArtifacts(root, [ownerPreparation]);
      }
      const acquired = await tryCreateOwner(
        key,
        root,
        payload,
        ownerPreparation,
        directoryRename,
      );
      if (acquired === undefined) throw busy();
      await lifecycleBarrier?.("owner-installed");
      return acquired;
    } finally {
      if (quarantine !== undefined) {
        await rm(quarantine, { force: true, recursive: true });
      }
      await releaseGenerationGuard(guard);
    }
  } finally {
    if (ownerPreparation !== undefined) {
      await rm(ownerPreparation, { force: true, recursive: true });
    }
    await rm(guardPreparation.path, { force: true, recursive: true });
    if (maintenance !== undefined) {
      await releaseGenerationGuard(maintenance);
    }
  }
}

async function reserveGenerationArtifact(
  root: string,
  observed: ObservedLock,
): Promise<GuardPreparation> {
  const maintenance = await acquireDirectoryMaintenance(dirname(root));
  if (maintenance === undefined) throw busy();
  const preparation = generationGuardPreparation(root, observed);
  try {
    await reserveLockArtifacts(root, [preparation.path]);
    return preparation;
  } finally {
    await releaseGenerationGuard(maintenance);
  }
}

async function ensureLockContainer(
  root: string,
  directory: string,
): Promise<boolean> {
  const existing = await safeLstat(root);
  if (existing !== undefined) return existing.isDirectory();
  if (!(await ensureGlobalLockCapacity(directory, basename(root)))) {
    throw capacityExceeded();
  }
  return tryMkdir(root);
}

function isPastArtifactGrace(modifiedAt: number): boolean {
  return Date.now() - modifiedAt >= LOCK_ARTIFACT_GRACE_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertOwner(handle: LockHandle, payload: LockPayload): void {
  if (payload.owner !== handle.owner) throw notOwned();
}

function validateKey(key: string): void {
  if (!/^[a-f0-9]{64}$/u.test(key)) {
    throw new LockError("LOCK_INVALID", "Lock key must be a sha256 hex digest");
  }
}

function validateTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new LockError("LOCK_INVALID", "Lock TTL must be positive");
  }
}

function busy(): LockError {
  return new LockError(
    "LOCK_BUSY",
    "Review lock is held by another owner; coordination is local-host only",
  );
}

function notOwned(): LockError {
  return new LockError("LOCK_NOT_OWNED", "Lock owner token mismatch");
}

function capacityExceeded(): LockError {
  return new LockError(
    "LOCK_CAPACITY_EXCEEDED",
    "Lock storage capacity could not be restored within cleanup limits",
  );
}

async function removeEmptyContainer(path: string): Promise<void> {
  const maintenance = await acquireDirectoryMaintenance(dirname(path));
  if (maintenance === undefined) return;
  try {
    await rmdir(path);
  } catch {
    // A contender may already have reused the stable key container.
  } finally {
    await releaseGenerationGuard(maintenance);
  }
}
