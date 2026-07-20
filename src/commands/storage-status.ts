import { readdir } from "node:fs/promises";

import {
  MAX_LOCAL_WAITERS_PER_KEY,
  MAX_SINGLE_FLIGHT_WAIT_MS,
} from "../review/single-flight.js";
import {
  cacheCoordinationMode,
  cacheEntriesDirectory,
  lockCoordinationMode,
  locksDirectory,
  platformCacheDirectory,
  platformStateDirectory,
  runsDirectory,
  transcriptsDirectory,
} from "../storage/paths.js";

export async function runStorageStatusCommand(options?: {
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const env = options?.env ?? process.env;
  const lines = [
    "Storage / coordination status:",
    `stateDir: ${platformStateDirectory(env)}`,
    `cacheDir: ${platformCacheDirectory(env)}`,
    `runsDir: ${runsDirectory(env)}`,
    `locksDir: ${locksDirectory(env)}`,
    `cacheEntriesDir: ${cacheEntriesDirectory(env)}`,
    `transcriptsDir: ${transcriptsDirectory(env)}`,
    `lockMode: ${lockCoordinationMode(env)}`,
    `cacheMode: ${cacheCoordinationMode(env)}`,
    "crossMachineFencing: unsupported",
    `localWaitersPerKeyPerHost: ${MAX_LOCAL_WAITERS_PER_KEY.toString()}`,
    `singleFlightWaitCeilingMs: ${MAX_SINGLE_FLIGHT_WAIT_MS.toString()}`,
    "sharedPathEnv (placement only): CQ_SHARED_STATE_DIR | CQ_SHARED_LOCK_DIR | CQ_SHARED_CACHE_DIR",
  ];
  try {
    const locks = (await readdir(locksDirectory(env))).filter((name) =>
      name.endsWith(".lock"),
    );
    lines.push(`activeLocks: ${String(locks.length)}`);
  } catch {
    lines.push("activeLocks: 0 (directory missing)");
  }
  try {
    const entries = (await readdir(cacheEntriesDirectory(env))).filter((name) =>
      name.endsWith(".json"),
    );
    lines.push(`cacheEntries: ${String(entries.length)}`);
  } catch {
    lines.push("cacheEntries: 0 (directory missing)");
  }
  try {
    const runs = (await readdir(runsDirectory(env))).filter((name) =>
      name.endsWith(".json"),
    );
    lines.push(`storedRuns: ${String(runs.length)}`);
  } catch {
    lines.push("storedRuns: 0 (directory missing)");
  }
  lines.push("");
  return { exitCode: 0, output: `${lines.join("\n")}\n` };
}
