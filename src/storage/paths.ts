import { homedir } from "node:os";
import { join } from "node:path";

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

export function runsDirectory(env?: NodeJS.ProcessEnv): string {
  return join(platformStateDirectory(env), "runs");
}

export function locksDirectory(env?: NodeJS.ProcessEnv): string {
  return join(platformStateDirectory(env), "locks");
}

export function cacheEntriesDirectory(env?: NodeJS.ProcessEnv): string {
  return join(platformCacheDirectory(env), "entries");
}
