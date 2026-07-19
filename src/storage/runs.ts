import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { ReviewRunResult } from "../review/orchestrator.js";
import { runsDirectory } from "./paths.js";

export interface StoredRunRecord {
  readonly runId: string;
  readonly createdAt: string;
  readonly gate: ReviewRunResult["gate"];
  readonly reportHash: string;
  readonly snapshotContentHash: string;
  readonly inputKind: string;
  readonly scope: string;
  readonly findings: ReviewRunResult["findings"];
  readonly uncertain: ReviewRunResult["uncertain"];
  readonly incomplete: boolean;
  readonly providerAttempts: number;
  readonly promptBundleVersion: string;
  readonly sensitiveTranscript?: boolean;
}

export const MAX_STORED_RUNS = 200;

function sanitize(result: ReviewRunResult): StoredRunRecord {
  return Object.freeze({
    runId: result.runId,
    createdAt: new Date().toISOString(),
    gate: result.gate,
    reportHash: result.reportHash,
    snapshotContentHash: result.snapshot.contentHash,
    inputKind: result.snapshot.inputKind,
    scope: result.snapshot.scope,
    findings: result.findings,
    uncertain: result.uncertain,
    incomplete: result.incomplete,
    providerAttempts: result.providerAttempts,
    promptBundleVersion: result.promptBundleVersion,
  });
}

async function atomicWrite(path: string, body: string): Promise<void> {
  const temporary = `${path}.${createHash("sha1").update(path).digest("hex").slice(0, 8)}.tmp`;
  await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export async function storeRun(
  result: ReviewRunResult,
  env?: NodeJS.ProcessEnv,
): Promise<StoredRunRecord> {
  const directory = runsDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const record = sanitize(result);
  const path = join(directory, `${record.runId}.json`);
  await atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
  await enforceRetention(directory);
  return record;
}

async function enforceRetention(directory: string): Promise<void> {
  const entries = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (entries.length <= MAX_STORED_RUNS) return;
  const stale = entries.slice(0, entries.length - MAX_STORED_RUNS);
  await Promise.all(
    stale.map(async (name) => {
      await rm(join(directory, name), { force: true });
    }),
  );
}

export async function loadRun(
  runId: string,
  env?: NodeJS.ProcessEnv,
): Promise<StoredRunRecord> {
  if (!/^[0-9a-f-]{36}$/iu.test(runId)) {
    throw new Error("Run id is invalid");
  }
  const path = join(runsDirectory(env), `${runId}.json`);
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as StoredRunRecord;
}

export async function listRuns(
  env?: NodeJS.ProcessEnv,
): Promise<readonly StoredRunRecord[]> {
  const directory = runsDirectory(env);
  try {
    const entries = (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
    const records: StoredRunRecord[] = [];
    for (const name of entries.slice(0, 50)) {
      const raw = await readFile(join(directory, name), "utf8");
      records.push(JSON.parse(raw) as StoredRunRecord);
    }
    return records;
  } catch {
    return [];
  }
}
