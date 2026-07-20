import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function platformStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.CQ_STATE_DIR !== undefined && env.CQ_STATE_DIR.length > 0) {
    return env.CQ_STATE_DIR;
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "code-quality");
  }
  if (process.platform === "win32") {
    const base = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "code-quality");
  }
  const xdg = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(xdg, "code-quality");
}

export function platformCacheDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.CQ_CACHE_DIR !== undefined && env.CQ_CACHE_DIR.length > 0) {
    return env.CQ_CACHE_DIR;
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "code-quality");
  }
  if (process.platform === "win32") {
    const base = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "code-quality", "Cache");
  }
  const xdg = env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(xdg, "code-quality");
}

/**
 * Operator-selected lock path. A shared path changes placement only; the lock
 * protocol deliberately guarantees single-flight on one host, not fencing
 * across machines.
 */
export function locksDirectory(env?: NodeJS.ProcessEnv): string {
  const processEnv = env ?? process.env;
  const sharedLock = processEnv.CQ_SHARED_LOCK_DIR?.trim();
  if (sharedLock !== undefined && sharedLock.length > 0) {
    if (!isAbsolute(sharedLock)) {
      throw new Error("CQ_SHARED_LOCK_DIR must be an absolute path");
    }
    return sharedLock;
  }
  const sharedState = processEnv.CQ_SHARED_STATE_DIR?.trim();
  if (sharedState !== undefined && sharedState.length > 0) {
    if (!isAbsolute(sharedState)) {
      throw new Error("CQ_SHARED_STATE_DIR must be an absolute path");
    }
    return join(sharedState, "locks");
  }
  return join(platformStateDirectory(processEnv), "locks");
}

export function runsDirectory(env?: NodeJS.ProcessEnv): string {
  return join(platformStateDirectory(env), "runs");
}

export function transcriptsDirectory(env?: NodeJS.ProcessEnv): string {
  return join(platformStateDirectory(env), "transcripts");
}

/** Shared-path settings change cache placement, not coordination guarantees. */
export function cacheEntriesDirectory(env?: NodeJS.ProcessEnv): string {
  const processEnv = env ?? process.env;
  const sharedCache = processEnv.CQ_SHARED_CACHE_DIR?.trim();
  if (sharedCache !== undefined && sharedCache.length > 0) {
    if (!isAbsolute(sharedCache)) {
      throw new Error("CQ_SHARED_CACHE_DIR must be an absolute path");
    }
    return sharedCache;
  }
  const sharedState = processEnv.CQ_SHARED_STATE_DIR?.trim();
  if (sharedState !== undefined && sharedState.length > 0) {
    if (!isAbsolute(sharedState)) {
      throw new Error("CQ_SHARED_STATE_DIR must be an absolute path");
    }
    return join(sharedState, "cache", "entries");
  }
  return join(platformCacheDirectory(processEnv), "entries");
}

export function lockCoordinationMode(
  env?: NodeJS.ProcessEnv,
): "local-host-only" {
  void env;
  return "local-host-only";
}

export function cacheCoordinationMode(
  env?: NodeJS.ProcessEnv,
): "local-host-only" {
  void env;
  return "local-host-only";
}
