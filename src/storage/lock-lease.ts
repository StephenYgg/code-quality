import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isProcessAlive,
  localHost,
  type LockDirectoryRename,
  tryInstallPreparedDirectory,
  tryRenameDirectory,
} from "./lock-platform.js";

export interface LockHandle {
  readonly key: string;
  readonly owner: string;
  readonly path: string;
  readonly shared: false;
  readonly host: string;
  readonly pid: number;
  readonly directoryRename?: LockDirectoryRename;
}

export class LockError extends Error {
  constructor(
    readonly code:
      | "LOCK_BUSY"
      | "LOCK_NOT_OWNED"
      | "LOCK_INVALID"
      | "LOCK_CAPACITY_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "LockError";
  }
}

export interface LockPayload {
  readonly owner: string;
  readonly expiresAt: number;
  readonly host: string;
  readonly pid: number;
}

export interface ObservedLock {
  readonly kind: "directory" | "legacy-file";
  readonly payload: LockPayload;
}

export interface GuardPayload {
  readonly token: string;
  readonly owner: string;
  readonly host: string;
  readonly pid: number;
}

export interface GuardHandle {
  readonly path: string;
  readonly token: string;
  readonly quarantine?: string;
  readonly directoryRename?: LockDirectoryRename;
}

export interface GuardPreparation {
  readonly path: string;
  readonly payload: GuardPayload;
}

export const OWNER_DIRECTORY = "owner";
export const LEASE_FILE = "lease.json";
export const GUARD_FILE = "guard.json";

export function newLockPayload(ttlMs: number): LockPayload {
  return {
    owner: randomUUID(),
    expiresAt: Date.now() + ttlMs,
    host: localHost(),
    pid: process.pid,
  };
}

export function newGuardPayload(owner: string): GuardPayload {
  return {
    token: randomUUID(),
    owner,
    host: localHost(),
    pid: process.pid,
  };
}

export async function tryCreateOwner(
  key: string,
  root: string,
  payload: LockPayload,
  prepared: string,
  directoryRename?: LockDirectoryRename,
): Promise<LockHandle | undefined> {
  const owner = join(root, OWNER_DIRECTORY);
  try {
    await writeFile(join(prepared, LEASE_FILE), jsonBody(payload), {
      flag: "wx",
      mode: 0o600,
    });
    if (!(await tryInstallPreparedDirectory(prepared, owner, directoryRename)))
      return undefined;
  } finally {
    await rm(prepared, { force: true, recursive: true });
  }
  return {
    key,
    owner: payload.owner,
    path: root,
    shared: false,
    host: payload.host,
    pid: payload.pid,
    ...(directoryRename === undefined ? {} : { directoryRename }),
  };
}

export function ownerPreparationPath(
  root: string,
  payload: LockPayload,
): string {
  return join(root, `.owner-${payload.owner}.prepared`);
}

export async function replaceLockPayload(
  root: string,
  payload: LockPayload,
): Promise<void> {
  const path = join(root, OWNER_DIRECTORY, LEASE_FILE);
  const temporary = join(root, OWNER_DIRECTORY, `.lease-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, jsonBody(payload), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readObservedLock(
  root: string,
): Promise<ObservedLock | undefined> {
  const directoryPayload = await readLockPayload(
    join(root, OWNER_DIRECTORY, LEASE_FILE),
  );
  if (directoryPayload !== undefined) {
    return { kind: "directory", payload: directoryPayload };
  }
  const legacyPayload = await readLockPayload(root);
  return legacyPayload === undefined
    ? undefined
    : { kind: "legacy-file", payload: legacyPayload };
}

export async function readLockPayload(
  path: string,
): Promise<LockPayload | undefined> {
  try {
    return parseLockPayload(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

export function canReclaimLock(payload: LockPayload): boolean {
  return payload.host === localHost() && !isProcessAlive(payload.pid);
}

export async function acquireGenerationGuard(
  root: string,
  observed: ObservedLock,
  preparation: GuardPreparation,
  directoryRename?: LockDirectoryRename,
): Promise<GuardHandle | undefined> {
  const path = generationGuard(root, observed);
  const { path: prepared, payload } = preparation;
  try {
    await writeFile(join(prepared, GUARD_FILE), jsonBody(payload), {
      flag: "wx",
      mode: 0o600,
    });
    if (await tryInstallPreparedDirectory(prepared, path, directoryRename)) {
      return {
        path,
        token: payload.token,
        ...(directoryRename === undefined ? {} : { directoryRename }),
      };
    }
    const existing = await readGuardPayload(path);
    if (
      existing === undefined ||
      existing.owner !== observed.payload.owner ||
      !canReclaimGuard(existing)
    ) {
      return undefined;
    }
    const quarantine = `${path}.quarantine-${ownerSuffix(existing.token)}`;
    if (!(await tryRenameDirectory(path, quarantine, directoryRename)))
      return undefined;
    if (!(await tryInstallPreparedDirectory(prepared, path, directoryRename)))
      return undefined;
    return {
      path,
      token: payload.token,
      quarantine,
      ...(directoryRename === undefined ? {} : { directoryRename }),
    };
  } finally {
    await rm(prepared, { force: true, recursive: true });
  }
}

export function generationGuardPreparation(
  root: string,
  observed: ObservedLock,
): GuardPreparation {
  const path = generationGuard(root, observed);
  const payload = newGuardPayload(observed.payload.owner);
  return { path: `${path}.prepared-${payload.token}`, payload };
}

export async function releaseGenerationGuard(
  handle: GuardHandle,
): Promise<void> {
  const current = await readGuardPayload(handle.path);
  if (current?.token !== handle.token) {
    throw new LockError("LOCK_NOT_OWNED", "Generation guard token mismatch");
  }
  const retired = `${handle.path}.released-${handle.token}`;
  await (handle.directoryRename ?? rename)(handle.path, retired);
  await rm(retired, { force: true, recursive: true });
  if (handle.quarantine !== undefined) {
    await rm(handle.quarantine, { force: true, recursive: true });
  }
}

export async function readGuardPayload(
  path: string,
): Promise<GuardPayload | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(path, GUARD_FILE), "utf8"),
    );
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Partial<GuardPayload>;
    if (
      typeof candidate.token !== "string" ||
      candidate.token.length === 0 ||
      typeof candidate.owner !== "string" ||
      candidate.owner.length === 0 ||
      typeof candidate.host !== "string" ||
      candidate.host.length === 0 ||
      !Number.isSafeInteger(candidate.pid) ||
      (candidate.pid ?? 0) <= 0
    ) {
      return undefined;
    }
    return candidate as GuardPayload;
  } catch {
    return undefined;
  }
}

export function canReclaimGuard(payload: GuardPayload): boolean {
  return payload.host === localHost() && !isProcessAlive(payload.pid);
}

export function quarantinePath(root: string, observed: ObservedLock): string {
  const suffix = `${ownerSuffix(observed.payload.owner)}-${randomUUID()}`;
  return observed.kind === "legacy-file"
    ? `${root}.quarantine-${suffix}`
    : join(root, `.quarantine-${suffix}`);
}

export function ownerPath(root: string, kind: ObservedLock["kind"]): string {
  return kind === "legacy-file" ? root : join(root, OWNER_DIRECTORY);
}

export function jsonBody(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

function parseLockPayload(value: unknown): LockPayload | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<LockPayload>;
  if (
    typeof candidate.owner !== "string" ||
    candidate.owner.length === 0 ||
    typeof candidate.host !== "string" ||
    candidate.host.length === 0 ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid ?? 0) <= 0 ||
    !Number.isFinite(candidate.expiresAt)
  ) {
    return undefined;
  }
  return candidate as LockPayload;
}

function generationGuard(root: string, observed: ObservedLock): string {
  const suffix = ownerSuffix(observed.payload.owner);
  return observed.kind === "legacy-file"
    ? `${root}.operation-${suffix}`
    : join(root, `.operation-${suffix}`);
}

function ownerSuffix(owner: string): string {
  return createHash("sha256").update(owner).digest("hex").slice(0, 24);
}
