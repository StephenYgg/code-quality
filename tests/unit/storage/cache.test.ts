import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { toFindingDocument } from "../../../src/core/finding-document.js";
import type { Finding } from "../../../src/core/findings.js";
import {
  publishCacheEntry,
  readCacheEntry,
} from "../../../src/storage/cache.js";
import { isSchemaValidRecord } from "../../../src/storage/cache-record.js";
import { acquireLock, releaseLock } from "../../../src/storage/locks.js";
import type { StoredRunRecord } from "../../../src/storage/runs.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("review cache", () => {
  test("fails closed without throwing for incomplete or hostile run documents", () => {
    const key = "a".repeat(64);
    const record = sampleRecord(key);
    const { reproducibility: _reproducibility, ...withoutReproducibility } =
      record.runDocument;
    expect(_reproducibility).toBe(record.runDocument.reproducibility);
    const incomplete = { ...record, runDocument: withoutReproducibility };
    let incompleteResult: boolean | undefined;

    expect(() => {
      incompleteResult = isSchemaValidRecord(incomplete, key);
    }).not.toThrow();
    expect(incompleteResult).toBe(false);

    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "runDocument", {
      enumerable: true,
      get(): never {
        throw new Error("hostile cache document accessor");
      },
    });
    let hostileResult: boolean | undefined;
    expect(() => {
      hostileResult = isSchemaValidRecord(hostile, key);
    }).not.toThrow();
    expect(hostileResult).toBe(false);
    expect(isSchemaValidRecord(record, key)).toBe(true);
  });

  test("rejects parseable records that do not match run.schema.json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-schema-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "a".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    await writeFile(join(entries, `${key}.json`), "{}\n", { mode: 0o600 });

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("removes a corrupt cache generation after rejecting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-corrupt-clean-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "f".repeat(64);
    const entries = join(directory, "entries");
    const path = join(entries, `${key}.json`);
    await mkdir(entries, { mode: 0o700 });
    await writeFile(path, "{}\n", { mode: 0o600 });

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not delete a valid generation that replaces corrupt data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-corrupt-race-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "e".repeat(64);
    const entries = join(directory, "entries");
    const path = join(entries, `${key}.json`);
    await mkdir(entries, { mode: 0o700 });
    await writeFile(path, "{}\n", { mode: 0o600 });
    const maintenanceKey = createHash("sha256")
      .update("cq-cache-maintenance:v1\0")
      .update(entries)
      .digest("hex");
    const guard = await acquireLock(maintenanceKey, {
      ttlMs: 10_000,
      env: { CQ_STATE_DIR: entries },
    });

    const rejectedGeneration = readCacheEntry(key, env);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const replacement = `${path}.replacement`;
    await writeFile(replacement, `${JSON.stringify(sampleRecord(key))}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(replacement, path);
    await releaseLock(guard);

    await expect(rejectedGeneration).resolves.toBeUndefined();
    await expect(readCacheEntry(key, env)).resolves.toBeDefined();
  });

  test("does not queue corrupt readers behind cache maintenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-corrupt-busy-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "d".repeat(64);
    const entries = join(directory, "entries");
    const path = join(entries, `${key}.json`);
    await mkdir(entries, { mode: 0o700 });
    await writeFile(path, "{}\n", { mode: 0o600 });
    const maintenanceKey = createHash("sha256")
      .update("cq-cache-maintenance:v1\0")
      .update(entries)
      .digest("hex");
    const guard = await acquireLock(maintenanceKey, {
      ttlMs: 10_000,
      env: { CQ_STATE_DIR: entries },
    });
    const pendingRead = readCacheEntry(key, env);
    try {
      const result = await Promise.race([
        pendingRead,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => {
            resolve("timed-out");
          }, 100);
        }),
      ]);

      expect(result).not.toBe("timed-out");
      expect(result).toBeUndefined();
    } finally {
      await releaseLock(guard);
      await pendingRead;
    }
  });

  test("rejects a valid record stored under a different content key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-key-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "b".repeat(64);
    const wrongKey = "c".repeat(64);
    await publishCacheEntry(key, sampleRecord(key), env);
    const entries = join(directory, "entries");
    await copyFile(
      join(entries, `${key}.json`),
      join(entries, `${wrongKey}.json`),
    );

    await expect(readCacheEntry(wrongKey, env)).resolves.toBeUndefined();
  });

  test("keeps cache entries within hard entry and cleanup bounds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-limit-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const limits = {
      maxEntries: 2,
      maxBytes: 1_000_000,
      maxEntryBytes: 500_000,
      maxAgeMs: 60_000,
      maxCleanupEntries: 2,
    };
    const oldestKey = "d".repeat(64);
    const newestKey = "f".repeat(64);
    const keys = [oldestKey, "e".repeat(64), newestKey];
    for (const key of keys) {
      await publishCacheEntry(key, sampleRecord(key), env, { limits });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const entries = (await readdir(join(directory, "entries"))).filter((name) =>
      name.endsWith(".json"),
    );
    expect(entries).toHaveLength(2);
    await expect(readCacheEntry(oldestKey, env)).resolves.toBeUndefined();
    await expect(readCacheEntry(newestKey, env)).resolves.toBeDefined();
  });

  test("rejects unsafe outer records even when runDocument is schema-valid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-outer-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "9".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    const corrupt = { ...sampleRecord(key), findings: "not-an-array" };
    await writeFile(
      join(entries, `${key}.json`),
      `${JSON.stringify(corrupt)}\n`,
      { mode: 0o600 },
    );

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("rejects null findings inside an otherwise coherent cache record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-finding-null-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "b".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    const corrupt = { ...sampleRecord(key), findings: [null] };
    await writeFile(
      join(entries, `${key}.json`),
      `${JSON.stringify(corrupt)}\n`,
      { mode: 0o600 },
    );

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("accepts all finding buckets, blocking verification state, and diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-lifecycles-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "7".repeat(64);
    const corroborated: Finding = {
      ...sampleFinding(),
      id: "corroborated-1",
      lifecycle: "corroborated",
      blockingVerificationUnresolved: true,
    };
    const waived: Finding = {
      ...sampleFinding(),
      id: "waived-1",
      lifecycle: "waived",
    };
    const findingDocuments = [
      toFindingDocument(corroborated),
      toFindingDocument(waived),
    ];
    const record = sampleRecord(key);
    const enriched = {
      ...record,
      corroborated: [corroborated],
      waived: [waived],
      diagnostics: [
        {
          code: "PROVIDER_RESPONSE_INVALID" as const,
          stageId: "behavior",
          path: "/candidates/0",
          message: "Candidate needs trusted verification",
        },
      ],
      findingDocuments,
      findingIds: findingDocuments.map((finding) => finding.id),
      runDocument: {
        ...record.runDocument,
        findingIds: findingDocuments.map((finding) => finding.id),
      },
    };

    await publishCacheEntry(key, enriched, env);

    await expect(readCacheEntry(key, env)).resolves.toMatchObject({
      corroborated: [
        expect.objectContaining({
          id: "corroborated-1",
          blockingVerificationUnresolved: true,
        }),
      ],
      waived: [expect.objectContaining({ id: "waived-1" })],
      diagnostics: [
        expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }),
      ],
    });
  });

  test.each([
    [
      "too many entries",
      Array.from({ length: 33 }, () => ({
        code: "PROVIDER_RESPONSE_INVALID",
        stageId: "behavior",
        message: "Invalid provider response",
      })),
    ],
    [
      "an oversized message",
      [
        {
          code: "PROVIDER_RESPONSE_INVALID",
          stageId: "behavior",
          message: "x".repeat(513),
        },
      ],
    ],
    [
      "an unknown code",
      [
        {
          code: "PROVIDER_UNKNOWN",
          stageId: "behavior",
          message: "Unknown diagnostic",
        },
      ],
    ],
    [
      "an unexpected field",
      [
        {
          code: "PROVIDER_RESPONSE_INVALID",
          stageId: "behavior",
          message: "Invalid provider response",
          rawProviderOutput: "must not be retained",
        },
      ],
    ],
  ])("rejects stored diagnostics with %s", async (_, diagnostics) => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-diagnostic-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "8".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    await writeFile(
      join(entries, `${key}.json`),
      `${JSON.stringify({ ...sampleRecord(key), diagnostics })}\n`,
      { mode: 0o600 },
    );

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("rejects malformed score assessments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-assessment-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "c".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    const corrupt = {
      ...sampleRecord(key),
      assessments: [
        {
          minorId: "behavior-correctness",
          status: "scored",
          rating: "5",
          confidence: "high",
          evidence: [],
          explanation: "",
        },
      ],
    };
    await writeFile(
      join(entries, `${key}.json`),
      `${JSON.stringify(corrupt)}\n`,
      { mode: 0o600 },
    );

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("rejects malformed exported finding documents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-finding-doc-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "d".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    const corrupt = { ...sampleRecord(key), findingDocuments: [null] };
    await writeFile(
      join(entries, `${key}.json`),
      `${JSON.stringify(corrupt)}\n`,
      { mode: 0o600 },
    );

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("rejects finding ids missing from the internal findings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-finding-ids-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "e".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    const finding = sampleFinding();
    const findingDocument = toFindingDocument(finding);
    const corrupt = {
      ...sampleRecord(key),
      findingDocuments: [findingDocument],
      findingIds: [finding.id],
      runDocument: {
        ...sampleRecord(key).runDocument,
        findingIds: [finding.id],
      },
    };
    await writeFile(
      join(entries, `${key}.json`),
      `${JSON.stringify(corrupt)}\n`,
      { mode: 0o600 },
    );

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("rejects malformed outer score metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-score-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "0".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    const valid = sampleRecord(key);
    const corrupt = {
      ...valid,
      score: { ...valid.score, normalizedTenths: "0" },
    };
    await writeFile(
      join(entries, `${key}.json`),
      `${JSON.stringify(corrupt)}\n`,
      { mode: 0o600 },
    );

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("rejects malformed outer timestamp metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-timestamps-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "1".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    const corrupt = {
      ...sampleRecord(key),
      timestamps: { startedAt: "not-a-timestamp" },
    };
    await writeFile(
      join(entries, `${key}.json`),
      `${JSON.stringify(corrupt)}\n`,
      { mode: 0o600 },
    );

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test.each([
    ["comparisonBase", { comparisonBase: "other-base" }],
    ["providerVersion", { providerVersion: "other-provider" }],
    ["fromCache", { fromCache: true }],
    ["sensitiveTranscript", { sensitiveTranscript: "yes" }],
    ["unknown fields", { unexpected: true }],
  ])("rejects incoherent or unsafe optional metadata: %s", async (_, extra) => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-optional-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "2".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    const corrupt = { ...sampleRecord(key), ...extra };
    await writeFile(
      join(entries, `${key}.json`),
      `${JSON.stringify(corrupt)}\n`,
      { mode: 0o600 },
    );

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("rejects outer metadata that disagrees with runDocument", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-coherence-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "a".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    const mismatched = { ...sampleRecord(key), scoreGate: "BLOCK" };
    await writeFile(
      join(entries, `${key}.json`),
      `${JSON.stringify(mismatched)}\n`,
      { mode: 0o600 },
    );

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("rejects legacy records missing the outer content bundle hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-bundle-old-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "1".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    const legacy: {
      -readonly [Key in keyof StoredRunRecord]?: StoredRunRecord[Key];
    } = { ...sampleRecord(key) };
    delete legacy.contentBundleHash;
    await writeFile(
      join(entries, `${key}.json`),
      `${JSON.stringify(legacy)}\n`,
      { mode: 0o600 },
    );

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("rejects a content bundle hash that disagrees with runDocument", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cq-cache-bundle-mismatch-"),
    );
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "2".repeat(64);
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    const mismatched = {
      ...sampleRecord(key),
      contentBundleHash: "7".repeat(64),
    };
    await writeFile(
      join(entries, `${key}.json`),
      `${JSON.stringify(mismatched)}\n`,
      { mode: 0o600 },
    );

    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("rejects a coherent record for a different captured content bundle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-bundle-current-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "3".repeat(64);
    await publishCacheEntry(key, sampleRecord(key), env);

    await expect(
      readCacheEntry(key, env, {
        expectedContentBundleHash: "7".repeat(64),
      }),
    ).resolves.toBeUndefined();
  });

  test("refuses to publish incoherent content bundle hashes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-bundle-publish-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "4".repeat(64);
    const mismatched = {
      ...sampleRecord(key),
      contentBundleHash: "7".repeat(64),
    };

    await expect(publishCacheEntry(key, mismatched, env)).rejects.toThrow(
      /content bundle hash/iu,
    );
  });

  test("throws typed backpressure for an entry that exceeds byte limits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-bytes-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "8".repeat(64);
    const limits = {
      maxEntries: 2,
      maxBytes: 200,
      maxEntryBytes: 200,
      maxAgeMs: 60_000,
      maxCleanupEntries: 2,
    };

    await expect(
      publishCacheEntry(key, sampleRecord(key), env, { limits }),
    ).rejects.toMatchObject({
      name: "CacheCapacityError",
      code: "CACHE_CAPACITY_EXCEEDED",
    });

    await expect(readCacheEntry(key, env, { limits })).resolves.toBeUndefined();
  });

  test("removes cache entries older than the maximum age", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-age-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "7".repeat(64);
    const now = Date.now();
    const limits = {
      maxEntries: 2,
      maxBytes: 1_000_000,
      maxEntryBytes: 500_000,
      maxAgeMs: 10,
      maxCleanupEntries: 2,
    };
    await publishCacheEntry(key, sampleRecord(key), env, {
      limits,
      now: () => now,
    });

    await expect(
      readCacheEntry(key, env, { limits, now: () => now + 1_000 }),
    ).resolves.toBeUndefined();
  });

  test("limits stale cleanup deletions per publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-cleanup-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    for (let index = 0; index < 5; index += 1) {
      await writeFile(
        join(entries, `${index.toString(16).padStart(64, "0")}.json`),
        "{}\n",
        { mode: 0o600 },
      );
    }
    const key = "6".repeat(64);
    const limits = {
      maxEntries: 2,
      maxBytes: 1_000_000,
      maxEntryBytes: 500_000,
      maxAgeMs: 1,
      maxCleanupEntries: 2,
    };

    await expect(
      publishCacheEntry(key, sampleRecord(key), env, {
        limits,
        now: () => Date.now() + 10_000,
      }),
    ).rejects.toMatchObject({
      name: "CacheCapacityError",
      code: "CACHE_CAPACITY_EXCEEDED",
    });

    const remaining = (await readdir(entries)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(remaining).toHaveLength(3);
  });

  test("does not grow cache when temp cleanup cannot restore capacity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-temp-capacity-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const entries = join(directory, "entries");
    await mkdir(entries, { mode: 0o700 });
    for (let index = 0; index < 5; index += 1) {
      const artifactKey = index.toString(16).padStart(64, "0");
      await writeFile(
        join(
          entries,
          `${artifactKey}.json.00000000-0000-4000-8000-${index
            .toString()
            .padStart(12, "0")}.tmp`,
        ),
        "temporary\n",
        { mode: 0o600 },
      );
    }
    const key = "6".repeat(64);
    const limits = {
      maxEntries: 2,
      maxBytes: 1_000_000,
      maxEntryBytes: 500_000,
      maxAgeMs: 60_000,
      maxCleanupEntries: 2,
    };

    await expect(
      publishCacheEntry(key, sampleRecord(key), env, { limits }),
    ).rejects.toMatchObject({
      name: "CacheCapacityError",
      code: "CACHE_CAPACITY_EXCEEDED",
    });

    const remaining = await readdir(entries);
    expect(remaining.filter((name) => name.endsWith(".tmp"))).toHaveLength(3);
    expect(remaining).not.toContain(`${key}.json`);
  });

  test("serializes concurrent capacity checks on the local host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-concurrent-"));
    temporaryDirectories.push(directory);
    const limits = {
      maxEntries: 4,
      maxBytes: 2_000_000,
      maxEntryBytes: 500_000,
      maxAgeMs: 60_000,
      maxCleanupEntries: 4,
    };
    const keys = Array.from({ length: 16 }, (_, index) =>
      index.toString(16).padStart(64, "0"),
    );

    await Promise.all(
      keys.map(async (key, index) =>
        publishCacheEntry(
          key,
          sampleRecord(key),
          {
            CQ_CACHE_DIR: directory,
            CQ_STATE_DIR: join(directory, `state-${index.toString()}`),
          },
          { limits },
        ),
      ),
    );

    const entries = (await readdir(join(directory, "entries"))).filter((name) =>
      name.endsWith(".json"),
    );
    expect(entries.length).toBeLessThanOrEqual(4);
  });

  test("uses restricted permissions and leaves no temporary files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-cache-mode-"));
    temporaryDirectories.push(directory);
    const env = { CQ_CACHE_DIR: directory };
    const key = "5".repeat(64);
    await publishCacheEntry(key, sampleRecord(key), env);
    const entries = join(directory, "entries");

    expect((await stat(entries)).mode & 0o777).toBe(0o700);
    expect((await stat(join(entries, `${key}.json`))).mode & 0o777).toBe(0o600);
    expect((await readdir(entries)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });
});

function sampleRecord(cacheKey: string): StoredRunRecord {
  return {
    schemaVersion: "1",
    runId: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:01.000Z",
    gate: "PASS",
    reportHash: "2".repeat(64),
    snapshotContentHash: "4".repeat(64),
    contentBundleHash: "6".repeat(64),
    repository: "/tmp/cache-test",
    head: "1".repeat(40),
    inputKind: "staged",
    scope: "change",
    findings: [],
    corroborated: [],
    uncertain: [],
    waived: [],
    diagnostics: [],
    findingDocuments: [],
    findingIds: [],
    incomplete: false,
    providerAttempts: 1,
    promptBundleVersion: "cq-prompt-bundle/v2",
    assessments: [],
    scoreGate: "PASS",
    contextIncomplete: false,
    policyHash: "3".repeat(64),
    providerName: "fake",
    providerKind: "codex_cli",
    model: "fake-model",
    adapterVersion: "cq-provider-adapter/v1",
    cacheKey,
    score: {
      modelId: "cq-default",
      modelVersion: "1.0.0",
      normalizedTenths: 0,
      coverageTenths: 0,
    },
    timestamps: {
      startedAt: "2026-07-20T00:00:00.000Z",
      completedAt: "2026-07-20T00:00:01.000Z",
    },
    runDocument: {
      schemaVersion: "1",
      id: "00000000-0000-4000-8000-000000000001",
      input: {
        kind: "staged",
        scope: "change",
        repository: "/tmp/cache-test",
        head: "1".repeat(40),
        contentHash: "4".repeat(64),
        contentBundleHash: "6".repeat(64),
      },
      policyHash: "3".repeat(64),
      gate: "PASS",
      findingIds: [],
      score: {
        modelId: "cq-default",
        modelVersion: "1.0.0",
        normalizedTenths: 0,
        coverageTenths: 0,
      },
      timestamps: {
        startedAt: "2026-07-20T00:00:00.000Z",
        completedAt: "2026-07-20T00:00:01.000Z",
      },
      reproducibility: {
        promptBundleVersion: "cq-prompt-bundle/v2",
        providerName: "fake",
        providerKind: "codex_cli",
        model: "fake-model",
        adapterVersion: "cq-provider-adapter/v1",
        cacheKey,
        scoreGate: "PASS",
        contextIncomplete: false,
        providerAttempts: 1,
      },
    },
  };
}

function sampleFinding(): Finding {
  return {
    id: "finding-1",
    ruleId: "CQ-BEH-001",
    title: "A concrete cache finding",
    severity: "P2",
    lifecycle: "confirmed",
    disposition: "new",
    confidence: "high",
    stages: ["behavior"],
    evidence: "The cached result contains mismatched finding identities.",
    impact: "A reused review can omit a confirmed finding.",
    remediation: "Keep all finding identity projections coherent.",
  };
}
