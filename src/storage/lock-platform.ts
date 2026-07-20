import type { Stats } from "node:fs";
import { lstat, mkdir, rename, rmdir } from "node:fs/promises";
import { hostname } from "node:os";

export type LockDirectoryRename = (
  source: string,
  target: string,
) => Promise<void>;

export function localHost(): string {
  return hostname().slice(0, 120);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

export async function safeLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function tryMkdir(path: string): Promise<boolean> {
  try {
    await mkdir(path, { mode: 0o700 });
    return true;
  } catch (error) {
    if (isPathContention(error)) return false;
    throw error;
  }
}

export async function tryRenameDirectory(
  source: string,
  target: string,
  directoryRename?: LockDirectoryRename,
): Promise<boolean> {
  try {
    await (directoryRename ?? rename)(source, target);
    return true;
  } catch (error) {
    if (isPathContention(error)) return false;
    throw error;
  }
}

export async function tryInstallPreparedDirectory(
  prepared: string,
  canonical: string,
  directoryRename?: LockDirectoryRename,
): Promise<boolean> {
  if (await tryRenameDirectory(prepared, canonical, directoryRename)) {
    return true;
  }
  try {
    await rmdir(canonical);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      if (isPathContention(error)) return false;
      throw error;
    }
  }
  return tryRenameDirectory(prepared, canonical, directoryRename);
}

export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isPathContention(error: unknown): boolean {
  return (
    hasCode(error, "EEXIST") ||
    hasCode(error, "ENOENT") ||
    hasCode(error, "ENOTEMPTY") ||
    (process.platform === "darwin" && hasCode(error, "EINVAL"))
  );
}
