import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createReviewSnapshot } from "../../../src/core/snapshots.js";
import type { ReviewRunResult } from "../../../src/review/orchestrator.js";
import { acquireLock, releaseLock } from "../../../src/storage/locks.js";
import {
  listRuns,
  loadRun,
  MAX_RUN_CLEANUP_PER_WRITE,
  MAX_STORED_RUNS,
  storeRun,
} from "../../../src/storage/runs.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("run retention", () => {
  test("loadRun rejects schema-invalid stored records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-runs-invalid-load-"));
    temporaryDirectories.push(directory);
    const env = { CQ_STATE_DIR: directory };
    const runs = join(directory, "runs");
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await mkdir(runs, { mode: 0o700 });
    await writeFile(join(runs, `${runId}.json`), "{}\n", { mode: 0o600 });

    await expect(loadRun(runId, env)).rejects.toThrow(/invalid stored run/iu);
  });

  test("listRuns skips invalid records and continues with valid runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-runs-invalid-list-"));
    temporaryDirectories.push(directory);
    const env = { CQ_STATE_DIR: directory };
    const validId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const valid = await storeRun(
      makeResult(validId, "A confirmed finding remains in its own bucket."),
      storageOptions("2026-07-20"),
      env,
    );
    const confirmed = valid.findings[0];
    if (confirmed === undefined) throw new Error("missing test finding");
    const runs = join(directory, "runs");
    const wrongBucketId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await writeFile(
      join(runs, `${wrongBucketId}.json`),
      `${JSON.stringify({
        ...valid,
        findings: [],
        corroborated: [confirmed],
      })}\n`,
      { mode: 0o600 },
    );
    const invalidId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await writeFile(join(runs, `${invalidId}.json`), "{}\n", { mode: 0o600 });

    const listed = await listRuns(env);

    expect(listed.map((record) => record.runId)).toEqual([validId]);
  });

  test("evicts the oldest timestamp instead of the lowest run id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-runs-order-"));
    temporaryDirectories.push(directory);
    const env = { CQ_STATE_DIR: directory };
    const oldestRunId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    for (let index = 0; index < MAX_STORED_RUNS; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      const runId = `00000000-0000-4000-8000-${suffix}`;
      await storeRun(makeResult(runId), storageOptions("2026-07-20"), env);
    }
    await expect(
      storeRun(makeResult(oldestRunId), storageOptions("2020-01-01"), env),
    ).rejects.toMatchObject({ code: "RUN_STORAGE_CAPACITY_EXCEEDED" });

    const entries = (await readdir(join(directory, "runs"))).filter((name) =>
      name.endsWith(".json"),
    );
    expect(entries).toHaveLength(MAX_STORED_RUNS);
    expect(entries).not.toContain(`${oldestRunId}.json`);
  });

  test("bounds cleanup work when an existing directory is oversized", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-runs-cleanup-"));
    temporaryDirectories.push(directory);
    const env = { CQ_STATE_DIR: directory };
    const runs = join(directory, "runs");
    await mkdir(runs, { mode: 0o700 });
    const existingCount = MAX_STORED_RUNS + MAX_RUN_CLEANUP_PER_WRITE + 10;
    for (let index = 0; index < existingCount; index += 1) {
      await writeFile(
        join(runs, `${index.toString(16).padStart(36, "0")}.json`),
        "{}\n",
        { mode: 0o600 },
      );
    }

    const incomingRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await expect(
      storeRun(makeResult(incomingRunId), storageOptions("2026-07-20"), env),
    ).rejects.toMatchObject({ code: "RUN_STORAGE_CAPACITY_EXCEEDED" });

    const remaining = (await readdir(runs)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(remaining).toHaveLength(existingCount - MAX_RUN_CLEANUP_PER_WRITE);
    expect(remaining).not.toContain(`${incomingRunId}.json`);
  });

  test("does not grow run storage when temp cleanup cannot restore capacity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-runs-temp-capacity-"));
    temporaryDirectories.push(directory);
    const env = { CQ_STATE_DIR: directory };
    const runs = join(directory, "runs");
    await mkdir(runs, { mode: 0o700 });
    const artifactCount = MAX_STORED_RUNS + MAX_RUN_CLEANUP_PER_WRITE + 1;
    for (let index = 0; index < artifactCount; index += 1) {
      const runId = `00000000-0000-4000-8000-${index
        .toString()
        .padStart(12, "0")}`;
      await writeFile(
        join(
          runs,
          `${runId}.json.00000000-0000-4000-8000-${index
            .toString()
            .padStart(12, "0")}.tmp`,
        ),
        "temporary\n",
        { mode: 0o600 },
      );
    }
    const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    await expect(
      storeRun(makeResult(runId), storageOptions("2026-07-20"), env),
    ).rejects.toMatchObject({ code: "RUN_STORAGE_CAPACITY_EXCEEDED" });

    const remaining = await readdir(runs);
    expect(remaining.filter((name) => name.endsWith(".tmp"))).toHaveLength(
      artifactCount - MAX_RUN_CLEANUP_PER_WRITE,
    );
    expect(remaining).not.toContain(`${runId}.json`);
  });

  test("lists runs by record timestamp and writes restricted atomic files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-runs-mode-"));
    temporaryDirectories.push(directory);
    const env = { CQ_STATE_DIR: directory };
    const recentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const oldId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await storeRun(makeResult(recentId), storageOptions("2026-07-20"), env);
    await storeRun(makeResult(oldId), storageOptions("2020-01-01"), env);

    const listed = await listRuns(env);
    expect(listed.map((record) => record.runId)).toEqual([recentId, oldId]);
    const runs = join(directory, "runs");
    expect((await stat(runs)).mode & 0o777).toBe(0o700);
    expect((await stat(join(runs, `${recentId}.json`))).mode & 0o777).toBe(
      0o600,
    );
    expect((await readdir(runs)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });

  test("skips large list entries and continues with smaller runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-runs-list-budget-"));
    temporaryDirectories.push(directory);
    const env = { CQ_STATE_DIR: directory };
    const largeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const smallId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await storeRun(
      makeResult(largeId, "x".repeat(2 * 1024 * 1024 + 1)),
      storageOptions("2026-07-21"),
      env,
    );
    await storeRun(makeResult(smallId), storageOptions("2026-07-20"), env);

    const listed = await listRuns(env);

    expect(listed.map((record) => record.runId)).toEqual([smallId]);
  });

  test("keeps retention bounded under concurrent writers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-runs-concurrent-"));
    temporaryDirectories.push(directory);
    const env = { CQ_STATE_DIR: directory };
    for (let index = 0; index < MAX_STORED_RUNS; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      await storeRun(
        makeResult(`10000000-0000-4000-8000-${suffix}`),
        storageOptions("2026-07-20"),
        env,
      );
    }

    await Promise.all(
      Array.from({ length: 32 }, async (_, index) => {
        const suffix = index.toString(16).padStart(12, "0");
        await storeRun(
          makeResult(`20000000-0000-4000-8000-${suffix}`),
          storageOptions("2026-07-21"),
          env,
        );
      }),
    );

    const entries = (await readdir(join(directory, "runs"))).filter((name) =>
      name.endsWith(".json"),
    );
    expect(entries.length).toBeLessThanOrEqual(MAX_STORED_RUNS);
  });

  test("applies backpressure while run storage maintenance is owned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-runs-backpressure-"));
    temporaryDirectories.push(directory);
    const env = { CQ_STATE_DIR: directory };
    const runs = join(directory, "runs");
    const key = createHash("sha256")
      .update("cq-run-storage-maintenance:v1\0")
      .update(runs)
      .digest("hex");
    const guard = await acquireLock(key, {
      env: { CQ_STATE_DIR: runs },
      ttlMs: 10_000,
    });
    try {
      await expect(
        storeRun(
          makeResult("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
          storageOptions("2026-07-20"),
          env,
        ),
      ).rejects.toMatchObject({ code: "LOCK_BUSY" });
      const entries = (await readdir(runs)).filter((name) =>
        name.endsWith(".json"),
      );
      expect(entries).toEqual([]);
    } finally {
      await releaseLock(guard);
    }
  });
});

function storageOptions(day: string) {
  return {
    policyHash: "3".repeat(64),
    providerName: "fake",
    providerKind: "codex_cli",
    model: "fake-model",
    adapterVersion: "cq-provider-adapter/v1",
    startedAt: `${day}T00:00:00.000Z`,
  } as const;
}

function makeResult(runId: string, findingEvidence?: string): ReviewRunResult {
  const snapshot = createReviewSnapshot({
    inputKind: "staged",
    scope: "change",
    repository: "/tmp/run-test",
    head: "1".repeat(40),
    files: [],
    exclusions: [],
    incomplete: false,
  });
  return {
    runId,
    gate: "PASS",
    findings:
      findingEvidence === undefined
        ? []
        : [
            {
              id: "large-finding",
              ruleId: "CQ-BEH-001",
              title: "Large stored finding",
              severity: "P2",
              lifecycle: "confirmed",
              disposition: "new",
              confidence: "high",
              stages: ["behavior"],
              evidence: findingEvidence,
              impact: "The stored record is intentionally large.",
              remediation: "Skip it in bounded list views.",
            },
          ],
    corroborated: [],
    uncertain: [],
    waived: [],
    plan: {
      stages: ["universal"],
      signals: {},
      maxInFlight: 2,
      maxAttempts: 16,
      execution: "full",
    },
    snapshot,
    incomplete: false,
    providerAttempts: 1,
    promptBundleVersion: "cq-prompt-bundle/v2",
    reportHash: "2".repeat(64),
    contentBundleHash: "6".repeat(64),
    assessments: [],
    scoreGate: "PASS",
    contextIncomplete: false,
  };
}
