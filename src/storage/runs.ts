import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  opendir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { toFindingDocument } from "../core/finding-document.js";
import { toRunDocument } from "../core/run-document.js";
import type { ReviewRunResult } from "../review/orchestrator.js";
import { PROVIDER_ADAPTER_VERSION } from "../providers/soak.js";
import { readBoundedUtf8File } from "../core/bounded-file.js";
import { acquireLock, LockError, releaseLock } from "./locks.js";
import { runsDirectory } from "./paths.js";
import { projectRunDiagnostics } from "./run-projection.js";
import {
  isStoredRunRecord,
  type StoredRunRecord,
} from "./stored-run-record.js";

export type { StoredRunRecord } from "./stored-run-record.js";

export const MAX_STORED_RUNS = 200;
export const MAX_RUN_CLEANUP_PER_WRITE = 32;
export const MAX_STORED_RUN_BYTES = 16 * 1024 * 1024;
export const MAX_LIST_RUN_ENTRY_BYTES = 2 * 1024 * 1024;
export const MAX_LIST_RUN_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_LISTED_RUNS = 50;

export class RunStorageError extends Error {
  constructor(
    readonly code: "RUN_STORAGE_CAPACITY_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "RunStorageError";
  }
}

interface RunFile {
  readonly name: string;
  readonly path: string;
  readonly timestamp: number;
  readonly bytes: number;
  readonly storedRun: boolean;
  readonly cleanupArtifact: boolean;
}

export interface SanitizeRunOptions {
  readonly policyHash: string;
  readonly providerName: string;
  readonly providerKind: string;
  readonly model: string;
  readonly adapterVersion?: string;
  readonly providerVersion?: string;
  readonly startedAt?: string;
  readonly sensitiveTranscript?: boolean;
}

export function sanitizeRunRecord(
  result: ReviewRunResult,
  options: SanitizeRunOptions,
): StoredRunRecord {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const completedAt = new Date().toISOString();
  const adapterVersion = options.adapterVersion ?? PROVIDER_ADAPTER_VERSION;
  const findingBuckets = [
    result.findings,
    result.corroborated,
    result.uncertain,
    result.waived,
  ] as const;
  const findingDocuments = Object.freeze([
    ...findingBuckets.flatMap((findings) =>
      findings.map((finding) =>
        toFindingDocument(finding, {
          provider: options.providerName,
          model: options.model,
        }),
      ),
    ),
  ]);
  const diagnostics = projectRunDiagnostics(result.diagnostics);
  const runDocument = toRunDocument(result, {
    policyHash: options.policyHash,
    providerName: options.providerName,
    providerKind: options.providerKind,
    model: options.model,
    adapterVersion,
    startedAt,
    completedAt,
    ...(options.providerVersion === undefined
      ? {}
      : { providerVersion: options.providerVersion }),
  });
  return Object.freeze({
    schemaVersion: "1",
    runId: result.runId,
    createdAt: startedAt,
    completedAt,
    gate: result.gate,
    reportHash: result.reportHash,
    snapshotContentHash: result.snapshot.contentHash,
    contentBundleHash: result.contentBundleHash,
    repository: result.snapshot.repository,
    ...(result.snapshot.comparisonBase === undefined
      ? {}
      : { comparisonBase: result.snapshot.comparisonBase }),
    head: result.snapshot.head,
    inputKind: result.snapshot.inputKind,
    scope: result.snapshot.scope,
    findings: result.findings,
    corroborated: result.corroborated,
    uncertain: result.uncertain,
    waived: result.waived,
    diagnostics,
    findingDocuments,
    findingIds: Object.freeze(findingDocuments.map((item) => item.id)),
    incomplete: result.incomplete,
    providerAttempts: result.providerAttempts,
    promptBundleVersion: result.promptBundleVersion,
    scoreGate: result.scoreGate,
    assessments: result.assessments,
    contextIncomplete: result.contextIncomplete,
    policyHash: options.policyHash,
    providerName: options.providerName,
    providerKind: options.providerKind,
    model: options.model,
    adapterVersion,
    ...(options.providerVersion === undefined
      ? {}
      : { providerVersion: options.providerVersion }),
    ...(result.cacheKey === undefined ? {} : { cacheKey: result.cacheKey }),
    ...(result.fromCache === true ? { fromCache: true } : {}),
    ...(runDocument.score === undefined ? {} : { score: runDocument.score }),
    timestamps: Object.freeze({
      startedAt,
      completedAt,
    }),
    runDocument,
    ...(options.sensitiveTranscript === true
      ? { sensitiveTranscript: true }
      : {}),
  });
}

async function atomicWrite(
  path: string,
  body: string,
  timestamp: string,
): Promise<void> {
  if (Buffer.byteLength(body) > MAX_STORED_RUN_BYTES) {
    throw new Error("Stored run exceeds the file size limit");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
    const retainedAt = new Date(timestamp);
    if (Number.isNaN(retainedAt.getTime())) {
      throw new Error("Stored run timestamp is invalid");
    }
    await utimes(temporary, retainedAt, retainedAt);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function storeRun(
  result: ReviewRunResult,
  options: SanitizeRunOptions,
  env?: NodeJS.ProcessEnv,
): Promise<StoredRunRecord> {
  const directory = runsDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const record = sanitizeRunRecord(result, options);
  const path = join(directory, `${record.runId}.json`);
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_STORED_RUN_BYTES) {
    throw new Error("Stored run exceeds the file size limit");
  }
  const guard = await acquireRunStorageLock(directory);
  try {
    const canWrite = await makeRunCapacity(
      directory,
      `${record.runId}.json`,
      new Date(record.createdAt).getTime(),
    );
    if (!canWrite) {
      throw new RunStorageError(
        "RUN_STORAGE_CAPACITY_EXCEEDED",
        "Run storage capacity could not be restored within cleanup limits; review was not persisted",
      );
    }
    await atomicWrite(path, body, record.createdAt);
  } finally {
    await releaseLock(guard);
  }
  return record;
}

async function acquireRunStorageLock(directory: string) {
  const key = createHash("sha256")
    .update("cq-run-storage-maintenance:v1\0")
    .update(directory)
    .digest("hex");
  const deadline = Date.now() + 2_000;
  do {
    try {
      return await acquireLock(key, {
        env: { CQ_STATE_DIR: directory },
        ttlMs: 10_000,
      });
    } catch (error) {
      if (!(error instanceof LockError) || error.code !== "LOCK_BUSY") {
        throw error;
      }
      await delay(5 + Math.floor(Math.random() * 11));
    }
  } while (Date.now() < deadline);
  throw new LockError("LOCK_BUSY", "Run storage maintenance wait expired");
}

async function makeRunCapacity(
  directory: string,
  targetName: string,
  incomingTimestamp: number,
): Promise<boolean> {
  const scanLimit = MAX_STORED_RUNS + MAX_RUN_CLEANUP_PER_WRITE + 1;
  const { files, overflow } = await scanRunFiles(directory, scanLimit);
  const existing = files.find((file) => file.name === targetName);
  let entries = files.length - (existing === undefined ? 0 : 1) + 1;
  const candidates = files
    .filter((file) => file.name !== targetName)
    .sort((left, right) => left.timestamp - right.timestamp);
  let removed = 0;
  for (const candidate of candidates) {
    if (removed >= MAX_RUN_CLEANUP_PER_WRITE) break;
    if (!candidate.cleanupArtifact) continue;
    await rm(candidate.path, { force: true });
    entries -= 1;
    removed += 1;
  }
  for (const candidate of candidates) {
    if (
      removed >= MAX_RUN_CLEANUP_PER_WRITE ||
      (!overflow && entries <= MAX_STORED_RUNS)
    ) {
      break;
    }
    if (!candidate.storedRun) continue;
    if (!overflow && incomingTimestamp <= candidate.timestamp) return false;
    await rm(candidate.path, { force: true });
    entries -= 1;
    removed += 1;
  }
  return !overflow && entries <= MAX_STORED_RUNS;
}

async function scanRunFiles(
  directory: string,
  limit: number,
): Promise<{ readonly files: readonly RunFile[]; readonly overflow: boolean }> {
  const files: RunFile[] = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (!entry.isFile()) continue;
    if (files.length >= limit) return { files, overflow: true };
    const path = join(directory, entry.name);
    try {
      const metadata = await lstat(path);
      if (metadata.isFile()) {
        files.push({
          name: entry.name,
          path,
          timestamp: metadata.mtimeMs,
          bytes: metadata.size,
          storedRun: entry.name.endsWith(".json"),
          cleanupArtifact: isRunCleanupArtifact(entry.name),
        });
      }
    } catch {
      // A concurrent retention pass may already have removed the file.
    }
  }
  return { files, overflow: false };
}

function isRunCleanupArtifact(name: string): boolean {
  return /\.json\.[a-f0-9-]{36}\.(?:tmp|quarantine)$/u.test(name);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadRun(
  runId: string,
  env?: NodeJS.ProcessEnv,
): Promise<StoredRunRecord> {
  if (!/^[0-9a-f-]{36}$/iu.test(runId)) {
    throw new Error("Run id is invalid");
  }
  const path = join(runsDirectory(env), `${runId}.json`);
  const raw = await readBoundedUtf8File(path, MAX_STORED_RUN_BYTES);
  const parsed: unknown = JSON.parse(raw);
  if (!isStoredRunRecord(parsed)) throw new Error("Invalid stored run record");
  return parsed;
}

export async function listRuns(
  env?: NodeJS.ProcessEnv,
): Promise<readonly StoredRunRecord[]> {
  const directory = runsDirectory(env);
  try {
    const { files } = await scanRunFiles(
      directory,
      MAX_STORED_RUNS + MAX_RUN_CLEANUP_PER_WRITE + 1,
    );
    const entries = files
      .filter((file) => file.storedRun)
      .sort((left, right) => right.timestamp - left.timestamp);
    const records: StoredRunRecord[] = [];
    let remainingBytes = MAX_LIST_RUN_TOTAL_BYTES;
    for (const file of entries) {
      if (records.length >= MAX_LISTED_RUNS) break;
      if (
        file.bytes > MAX_LIST_RUN_ENTRY_BYTES ||
        file.bytes > remainingBytes
      ) {
        continue;
      }
      try {
        const raw = await readBoundedUtf8File(
          file.path,
          MAX_LIST_RUN_ENTRY_BYTES,
        );
        const parsed: unknown = JSON.parse(raw);
        if (!isStoredRunRecord(parsed)) continue;
        records.push(parsed);
        remainingBytes -= Buffer.byteLength(raw);
      } catch {
        // One corrupt or concurrently replaced run must not hide later runs.
      }
    }
    return records;
  } catch {
    return [];
  }
}
