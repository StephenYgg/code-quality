import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  canReclaimGuard,
  canReclaimLock,
  LEASE_FILE,
  LockError,
  OWNER_DIRECTORY,
  readGuardPayload,
  readLockPayload,
  readObservedLock,
} from "./lock-lease.js";
import { hasCode, safeLstat } from "./lock-platform.js";

export const MAX_LOCK_CONTAINERS = 1_024;
export const MAX_LOCK_ARTIFACTS_PER_CONTAINER = 128;
export const MAX_LOCK_CLEANUP_PER_ACQUIRE = 32;
export const LOCK_ARTIFACT_GRACE_MS = 60_000;
export const LOCK_MAINTENANCE_DIRECTORY = ".maintenance";

export async function ensureGlobalLockCapacity(
  directory: string,
  incomingName: string,
): Promise<boolean> {
  const scanLimit = MAX_LOCK_CONTAINERS + MAX_LOCK_CLEANUP_PER_ACQUIRE + 1;
  const entries: {
    readonly name: string;
    readonly path: string;
    readonly modifiedAt: number;
  }[] = [];
  let overflow = false;
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (entry.name === LOCK_MAINTENANCE_DIRECTORY) continue;
    if (entries.length >= scanLimit) {
      overflow = true;
      break;
    }
    const path = join(directory, entry.name);
    const metadata = await safeLstat(path);
    if (metadata === undefined) continue;
    entries.push({ name: entry.name, path, modifiedAt: metadata.mtimeMs });
  }
  const existing = entries.find((entry) => entry.name === incomingName);
  let retained = entries.length - (existing === undefined ? 0 : 1);
  let removed = 0;
  const candidates = [...entries].sort(
    (left, right) => left.modifiedAt - right.modifiedAt,
  );
  for (const candidate of candidates) {
    if (removed >= MAX_LOCK_CLEANUP_PER_ACQUIRE) break;
    if (!(await isReclaimableGlobalArtifact(candidate))) continue;
    const retired = `${candidate.path}.cleanup-${randomUUID()}`;
    try {
      await rename(candidate.path, retired);
      await rm(retired, { force: true, recursive: true });
      retained -= 1;
      removed += 1;
    } catch {
      // A concurrent release may already have removed the candidate.
    }
  }
  return !overflow && retained + 1 <= MAX_LOCK_CONTAINERS;
}

export async function cleanupDeadLocalArtifacts(
  root: string,
  requiredSlots = 0,
): Promise<boolean> {
  const scanLimit =
    MAX_LOCK_ARTIFACTS_PER_CONTAINER + MAX_LOCK_CLEANUP_PER_ACQUIRE + 1;
  const artifacts: {
    readonly name: string;
    readonly path: string;
    readonly modifiedAt: number;
  }[] = [];
  let overflow = false;
  let removed = 0;
  try {
    const handle = await opendir(root);
    for await (const entry of handle) {
      if (artifacts.length >= scanLimit) {
        overflow = true;
        break;
      }
      const path = join(root, entry.name);
      try {
        const metadata = await lstat(path);
        artifacts.push({
          name: entry.name,
          path,
          modifiedAt: metadata.mtimeMs,
        });
      } catch {
        // A concurrent owner operation may already have removed the entry.
      }
    }
    const candidates = artifacts
      .filter((artifact) => lockArtifactKind(artifact.name) !== undefined)
      .sort((left, right) => left.modifiedAt - right.modifiedAt);
    for (const artifact of candidates) {
      if (removed >= MAX_LOCK_CLEANUP_PER_ACQUIRE) break;
      const kind = lockArtifactKind(artifact.name);
      if (kind === undefined) continue;
      const payloadReclaimable =
        kind === "owner"
          ? canReclaimArtifactOwner(
              await readLockPayload(join(artifact.path, LEASE_FILE)),
            )
          : canReclaimArtifactGuard(await readGuardPayload(artifact.path));
      const payloadMissing =
        kind === "owner"
          ? (await readLockPayload(join(artifact.path, LEASE_FILE))) ===
            undefined
          : (await readGuardPayload(artifact.path)) === undefined;
      if (
        !payloadReclaimable &&
        !(payloadMissing && isPastArtifactGrace(artifact.modifiedAt))
      ) {
        continue;
      }
      const retired = `${artifact.path}.cleanup-${randomUUID()}`;
      try {
        await rename(artifact.path, retired);
        await rm(retired, { force: true, recursive: true });
        removed += 1;
      } catch {
        // Another contender may already have retired the same artifact.
      }
    }
    return (
      !overflow &&
      artifacts.length - removed + requiredSlots <=
        MAX_LOCK_ARTIFACTS_PER_CONTAINER
    );
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
}

export async function reserveLockArtifacts(
  root: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  const hasCapacity = await cleanupDeadLocalArtifacts(root, paths.length);
  if (!hasCapacity) {
    throw new LockError(
      "LOCK_CAPACITY_EXCEEDED",
      "Lock container capacity could not be restored within cleanup limits",
    );
  }
  const reserved: string[] = [];
  try {
    for (const path of paths) {
      await mkdir(path, { mode: 0o700 });
      reserved.push(path);
    }
  } catch (error) {
    await Promise.all(
      reserved.map(async (path) => rm(path, { force: true, recursive: true })),
    );
    throw error;
  }
}

async function isReclaimableGlobalArtifact(candidate: {
  readonly name: string;
  readonly path: string;
  readonly modifiedAt: number;
}): Promise<boolean> {
  if (candidate.name.endsWith(".lock")) {
    const observed = await readObservedLock(candidate.path);
    return (
      observed === undefined &&
      isPastArtifactGrace(candidate.modifiedAt) &&
      (await hasOnlyReclaimableContainerArtifacts(candidate.path))
    );
  }
  return (
    /^\.maintenance\.(?:released|quarantine)-/u.test(candidate.name) &&
    isPastArtifactGrace(candidate.modifiedAt)
  );
}

async function hasOnlyReclaimableContainerArtifacts(
  root: string,
): Promise<boolean> {
  try {
    const handle = await opendir(root);
    let inspected = 0;
    for await (const entry of handle) {
      inspected += 1;
      if (inspected > MAX_LOCK_ARTIFACTS_PER_CONTAINER) return false;
      const path = join(root, entry.name);
      const metadata = await safeLstat(path);
      if (metadata === undefined) continue;
      if (
        entry.name === OWNER_DIRECTORY ||
        /^\.operation-[a-f0-9]{24}$/u.test(entry.name)
      ) {
        if (
          !metadata.isDirectory() ||
          !isPastArtifactGrace(metadata.mtimeMs) ||
          !(await isEmptyDirectory(path))
        ) {
          return false;
        }
        continue;
      }
      const kind = lockArtifactKind(entry.name);
      if (kind === undefined) return false;
      if (kind === "owner") {
        const payload = await readLockPayload(join(path, LEASE_FILE));
        if (
          payload !== undefined
            ? !canReclaimLock(payload)
            : !isPastArtifactGrace(metadata.mtimeMs)
        ) {
          return false;
        }
        continue;
      }
      const payload = await readGuardPayload(path);
      if (
        payload !== undefined
          ? !canReclaimGuard(payload)
          : !isPastArtifactGrace(metadata.mtimeMs)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    const handle = await opendir(path);
    for await (const _entry of handle) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function lockArtifactKind(name: string): "owner" | "guard" | undefined {
  if (/^\.owner-.+\.prepared$/u.test(name) || /^\.quarantine-.+/u.test(name)) {
    return "owner";
  }
  return /^\.operation-.+\.(?:prepared|quarantine|released)-.+$/u.test(name)
    ? "guard"
    : undefined;
}

function canReclaimArtifactOwner(
  payload: Awaited<ReturnType<typeof readLockPayload>>,
): boolean {
  return payload !== undefined && canReclaimLock(payload);
}

function canReclaimArtifactGuard(
  payload: Awaited<ReturnType<typeof readGuardPayload>>,
): boolean {
  return payload !== undefined && canReclaimGuard(payload);
}

function isPastArtifactGrace(modifiedAt: number): boolean {
  return Date.now() - modifiedAt >= LOCK_ARTIFACT_GRACE_MS;
}
