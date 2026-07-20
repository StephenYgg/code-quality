import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runWithSingleFlight } from "../../../src/review/single-flight.js";
import {
  publishCacheEntry,
  readCacheEntry,
} from "../../../src/storage/cache.js";
import {
  acquireLock,
  LockError,
  releaseLock,
} from "../../../src/storage/locks.js";
import {
  RunStorageError,
  type StoredRunRecord,
} from "../../../src/storage/runs.js";

const temporaryDirectories: string[] = [];
const isContenderProcessWorker =
  process.env.CQ_SINGLE_FLIGHT_PROCESS_WORKER === "1";
const isWaiterProcessWorker =
  process.env.CQ_SINGLE_FLIGHT_WAITER_WORKER === "1";
const isProcessWorker = isContenderProcessWorker || isWaiterProcessWorker;
const CONTENT_BUNDLE_HASH = "6".repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe.skipIf(isProcessWorker)("runWithSingleFlight", () => {
  test("never publishes a cache entry when durable run storage fails", async () => {
    const env = await temporaryEnvironment("cq-flight-durability-failure-");
    const key = "d".repeat(64);
    let executions = 0;
    const execute = () =>
      runWithSingleFlight({
        key,
        contentBundleHash: CONTENT_BUNDLE_HASH,
        env,
        run: () => {
          executions += 1;
          return Promise.resolve({
            contentBundleHash: CONTENT_BUNDLE_HASH,
            incomplete: false,
            gate: "PASS",
            scoreGate: "PASS",
            diagnostics: [],
          } as never);
        },
        persistResult: () =>
          Promise.reject(
            new RunStorageError(
              "RUN_STORAGE_CAPACITY_EXCEEDED",
              "run storage is full",
            ),
          ),
        toRecord: () => sampleRecord(key),
      });

    const first = await execute();
    const second = await execute();

    expect(first).toMatchObject({
      kind: "incomplete",
      code: "RUN_STORAGE_CAPACITY_EXCEEDED",
    });
    expect(second).toMatchObject({
      kind: "incomplete",
      code: "RUN_STORAGE_CAPACITY_EXCEEDED",
    });
    expect(executions).toBe(2);
    await expect(
      readCacheEntry(key, env, {
        expectedContentBundleHash: CONTENT_BUNDLE_HASH,
      }),
    ).resolves.toBeUndefined();
  });

  test("returns winner and loser incomplete when durability fails before cache publish", async () => {
    const env = await temporaryEnvironment("cq-flight-durability-losers-");
    const key = "e".repeat(64);
    let executions = 0;
    let markStarted!: () => void;
    let finishRun!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const options = {
      key,
      contentBundleHash: CONTENT_BUNDLE_HASH,
      env,
      waitMs: 1_000,
      pollMs: 5,
      run: async () => {
        executions += 1;
        markStarted();
        await finish;
        return {
          contentBundleHash: CONTENT_BUNDLE_HASH,
          incomplete: false,
          gate: "PASS",
          scoreGate: "PASS",
          diagnostics: [],
        } as never;
      },
      persistResult: () =>
        Promise.reject(
          new RunStorageError(
            "RUN_STORAGE_CAPACITY_EXCEEDED",
            "run storage is full",
          ),
        ),
      toRecord: () => sampleRecord(key),
    } as const;
    const winner = runWithSingleFlight(options);
    await started;
    const loser = runWithSingleFlight(options);
    finishRun();

    const [winnerResult, loserResult] = await Promise.all([winner, loser]);

    expect(winnerResult).toMatchObject({
      kind: "incomplete",
      code: "RUN_STORAGE_CAPACITY_EXCEEDED",
    });
    expect(loserResult).toMatchObject({ kind: "incomplete" });
    expect(executions).toBe(1);
    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("returns winner and loser incomplete when cache capacity rejects publication", async () => {
    const env = await temporaryEnvironment("cq-flight-cache-capacity-");
    const key = "f".repeat(64);
    let executions = 0;
    let persisted = 0;
    let markStarted!: () => void;
    let finishRun!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const options = {
      key,
      contentBundleHash: CONTENT_BUNDLE_HASH,
      env,
      waitMs: 1_000,
      pollMs: 5,
      run: async () => {
        executions += 1;
        markStarted();
        await finish;
        return {
          contentBundleHash: CONTENT_BUNDLE_HASH,
          incomplete: false,
          gate: "PASS",
          scoreGate: "PASS",
          diagnostics: [],
        } as never;
      },
      persistResult: () => {
        persisted += 1;
        return Promise.resolve();
      },
      toRecord: () => ({
        ...sampleRecord(key),
        repository: "x".repeat(9 * 1024 * 1024),
      }),
    } as const;
    const winner = runWithSingleFlight(options);
    await started;
    const loser = runWithSingleFlight(options);
    finishRun();

    const [winnerResult, loserResult] = await Promise.all([winner, loser]);

    expect(winnerResult).toMatchObject({
      kind: "incomplete",
      code: "CACHE_CAPACITY_EXCEEDED",
    });
    expect(loserResult).toMatchObject({ kind: "incomplete" });
    expect(executions).toBe(1);
    expect(persisted).toBe(1);
    await expect(readCacheEntry(key, env)).resolves.toBeUndefined();
  });

  test("cancels a loser wait without executing the provider", async () => {
    const env = await temporaryEnvironment("cq-flight-cancel-");
    const key = "a".repeat(64);
    const winner = await acquireLock(key, { env });
    const controller = new AbortController();
    controller.abort();
    let executions = 0;

    await expect(
      runWithSingleFlight({
        key,
        contentBundleHash: CONTENT_BUNDLE_HASH,
        env,
        waitMs: 20,
        pollMs: 5,
        signal: controller.signal,
        run: () => {
          executions += 1;
          return Promise.resolve({} as never);
        },
        toRecord: () => ({}) as never,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(executions).toBe(0);
    await releaseLock(winner);
  });

  test("jitters loser polling within the wait budget", async () => {
    const env = await temporaryEnvironment("cq-flight-jitter-");
    const key = "b".repeat(64);
    const winner = await acquireLock(key, { env });
    let randomCalls = 0;

    const result = await runWithSingleFlight({
      key,
      contentBundleHash: CONTENT_BUNDLE_HASH,
      env,
      waitMs: 25,
      pollMs: 10,
      random: () => {
        randomCalls += 1;
        return 0.5;
      },
      run: () => Promise.resolve({} as never),
      toRecord: () => ({}) as never,
    });

    expect(result.kind).toBe("incomplete");
    expect(randomCalls).toBeGreaterThan(0);
    await releaseLock(winner);
  });

  test("rejects the 65th waiter for one key without allocating another wait", async () => {
    const env = await temporaryEnvironment("cq-flight-waiter-cap-");
    const key = "3".repeat(64);
    const winner = await acquireLock(key, { env });
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const overflowController = new AbortController();
    const admitted = new Set<number>();
    let overflowPolls = 0;
    let overflow: ReturnType<typeof runWithSingleFlight> | undefined;
    const waiters = controllers.slice(0, 64).map((controller, index) =>
      runWithSingleFlight({
        key,
        contentBundleHash: CONTENT_BUNDLE_HASH,
        env,
        waitMs: 15_000,
        pollMs: 1_000,
        signal: controller.signal,
        random: () => {
          admitted.add(index);
          return 0.5;
        },
        run: () => Promise.resolve({} as never),
        toRecord: () => ({}) as never,
      }),
    );
    try {
      await waitForCondition(() => admitted.size === 64, 10_000);
      overflow = runWithSingleFlight({
        key,
        contentBundleHash: CONTENT_BUNDLE_HASH,
        env,
        waitMs: 2_000,
        pollMs: 1_000,
        signal: overflowController.signal,
        random: () => {
          overflowPolls += 1;
          return 0.5;
        },
        run: () => Promise.resolve({} as never),
        toRecord: () => ({}) as never,
      });
      const result = await overflow;
      expect(result).toMatchObject({ kind: "incomplete" });
      expect(overflowPolls).toBe(0);
    } finally {
      for (const controller of controllers) controller.abort();
      overflowController.abort();
      await Promise.allSettled([
        ...waiters,
        ...(overflow === undefined ? [] : [overflow]),
      ]);
      await releaseLock(winner);
    }
  }, 20_000);

  test("releases a waiter slot after cancellation", async () => {
    const env = await temporaryEnvironment("cq-flight-waiter-release-");
    const key = "7".repeat(64);
    const winner = await acquireLock(key, { env });
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const admitted = new Set<number>();
    const waiters = controllers.map((controller, index) =>
      runWithSingleFlight({
        key,
        contentBundleHash: CONTENT_BUNDLE_HASH,
        env,
        waitMs: 15_000,
        pollMs: 1_000,
        signal: controller.signal,
        random: () => {
          admitted.add(index);
          return 0.5;
        },
        run: () => Promise.resolve({} as never),
        toRecord: () => ({}) as never,
      }),
    );
    try {
      await waitForCondition(() => admitted.size === 64, 10_000);
      const cancelledController = requiredItem(
        controllers[0],
        "first waiter controller",
      );
      const cancelledWaiter = requiredItem(waiters[0], "first waiter");
      cancelledController.abort();
      await expect(cancelledWaiter).rejects.toMatchObject({
        name: "AbortError",
      });

      let replacementPolls = 0;
      const replacement = await runWithSingleFlight({
        key,
        contentBundleHash: CONTENT_BUNDLE_HASH,
        env,
        waitMs: 20,
        pollMs: 5,
        random: () => {
          replacementPolls += 1;
          return 0.5;
        },
        run: () => Promise.resolve({} as never),
        toRecord: () => ({}) as never,
      });

      expect(replacementPolls).toBeGreaterThan(0);
      expect(replacement).toMatchObject({ kind: "incomplete" });
      if (replacement.kind !== "incomplete") {
        throw new Error("Replacement waiter did not return incomplete");
      }
      expect(replacement.reason).not.toMatch(/waiter limit/iu);
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(waiters);
      await releaseLock(winner);
    }
  }, 20_000);

  test("rejects without polling when all filesystem waiter slots are held", async () => {
    const env = await temporaryEnvironment("cq-flight-fs-waiter-cap-");
    const key = "9".repeat(64);
    const winner = await acquireLock(key, { env });
    const slots = await Promise.all(
      Array.from({ length: 64 }, async (_, index) =>
        acquireLock(waiterSlotKey(key, index), { env, ttlMs: 5_000 }),
      ),
    );
    let polls = 0;
    try {
      const result = await runWithSingleFlight({
        key,
        contentBundleHash: CONTENT_BUNDLE_HASH,
        env,
        waitMs: 100,
        pollMs: 10,
        random: () => {
          polls += 1;
          return 0.5;
        },
        run: () => Promise.resolve({} as never),
        toRecord: () => ({}) as never,
      });

      expect(result.kind).toBe("incomplete");
      if (result.kind !== "incomplete") {
        throw new Error("Expected the waiter limit to return incomplete");
      }
      expect(result.reason).toMatch(/waiter limit/iu);
      expect(polls).toBe(0);
    } finally {
      await Promise.all(slots.map(releaseLock));
      await releaseLock(winner);
    }
  });

  test("does not misclassify a winner failure as lock contention", async () => {
    const env = await temporaryEnvironment("cq-flight-error-boundary-");
    const key = "4".repeat(64);

    await expect(
      runWithSingleFlight({
        key,
        contentBundleHash: CONTENT_BUNDLE_HASH,
        env,
        waitMs: 20,
        pollMs: 5,
        run: () =>
          Promise.reject(
            new LockError("LOCK_BUSY", "provider returned a lock-like error"),
          ),
        toRecord: () => sampleRecord(key),
      }),
    ).rejects.toMatchObject({
      code: "LOCK_BUSY",
      message: "provider returned a lock-like error",
    });
  });

  test("does not reuse a coherent cache record for a different content bundle", async () => {
    const env = await temporaryEnvironment("cq-flight-bundle-cache-");
    const key = "5".repeat(64);
    const cachedBundleHash = "6".repeat(64);
    const currentBundleHash = "7".repeat(64);
    await publishCacheEntry(key, sampleRecord(key, cachedBundleHash), env);
    let executions = 0;

    const result = await runWithSingleFlight({
      key,
      contentBundleHash: currentBundleHash,
      env,
      run: () => {
        executions += 1;
        return Promise.resolve({
          contentBundleHash: currentBundleHash,
        } as never);
      },
      toRecord: () => sampleRecord(key, currentBundleHash),
    });

    expect(result.kind).toBe("executed");
    expect(executions).toBe(1);
  });

  test("rejects a winner record for a different content bundle", async () => {
    const env = await temporaryEnvironment("cq-flight-bundle-winner-");
    const key = "6".repeat(64);
    const currentBundleHash = "7".repeat(64);

    await expect(
      runWithSingleFlight({
        key,
        contentBundleHash: currentBundleHash,
        env,
        run: () =>
          Promise.resolve({ contentBundleHash: currentBundleHash } as never),
        toRecord: () => sampleRecord(key, "8".repeat(64)),
      }),
    ).rejects.toThrow(/content bundle hash/iu);
  });

  test.each([
    ["incomplete flag", { incomplete: true }],
    ["incomplete gate", { gate: "INCOMPLETE" }],
    ["incomplete score gate", { scoreGate: "INCOMPLETE" }],
    [
      "provider diagnostic",
      {
        diagnostics: [
          {
            code: "PROVIDER_CONFIG_INVALID",
            message: "Provider is temporarily invalid",
            stageId: "universal",
          },
        ],
      },
    ],
  ])("does not cache %s results", async (_, failure) => {
    const env = await temporaryEnvironment("cq-flight-incomplete-cache-");
    const key = "8".repeat(64);
    let executions = 0;
    const execute = () =>
      runWithSingleFlight({
        key,
        contentBundleHash: CONTENT_BUNDLE_HASH,
        env,
        run: () => {
          executions += 1;
          return Promise.resolve({
            contentBundleHash: CONTENT_BUNDLE_HASH,
            incomplete: false,
            gate: "PASS",
            scoreGate: "PASS",
            diagnostics: [],
            ...(executions === 1 ? failure : {}),
          } as never);
        },
        toRecord: () => sampleRecord(key),
      });

    const first = await execute();
    const recovered = await execute();

    expect(first.kind).toBe("executed");
    expect(recovered.kind).toBe("executed");
    expect(executions).toBe(2);
  });

  test("renews the lease while the provider run is still active", async () => {
    const env = await temporaryEnvironment("cq-flight-renew-");
    const key = "c".repeat(64);
    let markStarted!: () => void;
    let finishRun!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const flight = runWithSingleFlight({
      key,
      contentBundleHash: CONTENT_BUNDLE_HASH,
      env,
      waitMs: 200,
      pollMs: 5,
      leaseMs: 30,
      run: async () => {
        markStarted();
        await finish;
        return { contentBundleHash: CONTENT_BUNDLE_HASH } as never;
      },
      toRecord: () => sampleRecord(key),
    });
    await started;
    const leasePath = join(
      requiredValue(env.CQ_STATE_DIR, "CQ_STATE_DIR"),
      "locks",
      `${key}.lock`,
      "owner",
      "lease.json",
    );
    const initial = JSON.parse(await readFile(leasePath, "utf8")) as {
      readonly expiresAt: number;
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, 45));
      const renewed = JSON.parse(await readFile(leasePath, "utf8")) as {
        readonly expiresAt: number;
      };
      expect(renewed.expiresAt).toBeGreaterThan(initial.expiresAt);
    } finally {
      finishRun();
      await flight;
    }
  });

  test("has one provider winner across repeated concurrent races", async () => {
    const env = await temporaryEnvironment("cq-flight-winner-");
    for (let round = 0; round < 5; round += 1) {
      const key = round.toString(16).padStart(64, "0");
      let executions = 0;
      const results = await Promise.all(
        Array.from({ length: 16 }, async () =>
          runWithSingleFlight({
            key,
            contentBundleHash: CONTENT_BUNDLE_HASH,
            env,
            waitMs: 500,
            pollMs: 5,
            leaseMs: 100,
            run: async () => {
              executions += 1;
              await new Promise((resolve) => setTimeout(resolve, 15));
              return { contentBundleHash: CONTENT_BUNDLE_HASH } as never;
            },
            toRecord: () => sampleRecord(key),
          }),
        ),
      );

      expect(executions).toBe(1);
      expect(
        results.filter((result) => result.kind === "executed"),
      ).toHaveLength(1);
      expect(results.filter((result) => result.kind === "cached")).toHaveLength(
        15,
      );
    }
  });

  test("has one provider winner across repeated process races", async () => {
    for (let round = 0; round < 2; round += 1) {
      const env = await temporaryEnvironment(
        `cq-flight-process-${String(round)}-`,
      );
      const directory = requiredValue(env.CQ_STATE_DIR, "CQ_STATE_DIR");
      const key = (round + 13).toString(16).padStart(64, "0");
      const startPath = join(directory, "start");
      const providerLog = join(directory, "provider.log");
      const children = Array.from({ length: 8 }, (_, index) =>
        spawnProcessWorker({
          env,
          key,
          startPath,
          providerLog,
          readyPath: join(directory, `ready-${index.toString()}`),
        }),
      );
      await Promise.all(
        children.map(async (child) => waitForPath(child.readyPath)),
      );
      await writeFile(startPath, "go\n", { mode: 0o600 });
      const results = await Promise.all(
        children.map(async (child) => child.done),
      );
      expect(results).toEqual(Array.from({ length: 8 }, () => 0));
      const providers = (await readFile(providerLog, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0);
      expect(providers).toHaveLength(1);
    }
  }, 20_000);

  test("caps active waiters across 65 local processes before polling overflow", async () => {
    const env = await temporaryEnvironment("cq-flight-process-waiters-");
    const directory = requiredValue(env.CQ_STATE_DIR, "CQ_STATE_DIR");
    const key = "a".repeat(64);
    const startPath = join(directory, "waiters-start");
    const winner = await acquireLock(key, { env });
    const processCount = 8;
    const waitersPerProcess = 8;
    const children = Array.from({ length: processCount }, (_, index) =>
      spawnWaiterProcessWorker({
        env,
        key,
        startPath,
        readyPath: join(directory, `waiter-ready-${index.toString()}`),
        resultPath: join(directory, `waiter-result-${index.toString()}.json`),
        polledPath: join(directory, `waiter-polled-${index.toString()}`),
        waitMs: 60_000,
        waiterCount: waitersPerProcess,
      }),
    );
    let overflow: ReturnType<typeof spawnWaiterProcessWorker> | undefined;
    let winnerReleased = false;
    try {
      await Promise.all(
        children.map(async (child) => waitForPath(child.readyPath, 30_000)),
      );
      await writeFile(startPath, "go\n", { mode: 0o600 });
      await Promise.all(
        children.flatMap((child) =>
          child.polledPaths.map(async (path) => waitForPath(path, 30_000)),
        ),
      );
      overflow = spawnWaiterProcessWorker({
        env,
        key,
        startPath,
        readyPath: join(directory, "waiter-ready-overflow"),
        resultPath: join(directory, "waiter-result-overflow.json"),
        polledPath: join(directory, "waiter-polled-overflow"),
        waitMs: 5_000,
        waiterCount: 1,
      });
      await waitForPath(overflow.readyPath, 30_000);
      await expect(overflow.done).resolves.toBe(0);
      const overflowResult = JSON.parse(
        await readFile(overflow.resultPath, "utf8"),
      ) as { readonly polled: boolean; readonly reason: string };
      expect(overflowResult.polled).toBe(false);
      expect(overflowResult.reason).toMatch(/waiter limit/iu);

      await releaseLock(winner);
      winnerReleased = true;
      await expect(
        Promise.all(children.map((child) => child.done)),
      ).resolves.toEqual(Array.from({ length: processCount }, () => 0));
    } finally {
      if (!winnerReleased) await releaseLock(winner);
      await Promise.allSettled([
        ...children.map((child) => child.done),
        ...(overflow === undefined ? [] : [overflow.done]),
      ]);
    }
  }, 90_000);
});

describe.runIf(isContenderProcessWorker)("single-flight process worker", () => {
  test("process contender worker", async () => {
    const env = {
      CQ_STATE_DIR: requiredValue(process.env.CQ_STATE_DIR, "CQ_STATE_DIR"),
      CQ_CACHE_DIR: requiredValue(process.env.CQ_CACHE_DIR, "CQ_CACHE_DIR"),
    };
    const key = requiredValue(
      process.env.CQ_SINGLE_FLIGHT_KEY,
      "CQ_SINGLE_FLIGHT_KEY",
    );
    await writeFile(
      requiredValue(
        process.env.CQ_SINGLE_FLIGHT_READY,
        "CQ_SINGLE_FLIGHT_READY",
      ),
      "ready\n",
      { mode: 0o600 },
    );
    await waitForPath(
      requiredValue(
        process.env.CQ_SINGLE_FLIGHT_START,
        "CQ_SINGLE_FLIGHT_START",
      ),
    );

    const result = await runWithSingleFlight({
      key,
      contentBundleHash: CONTENT_BUNDLE_HASH,
      env,
      waitMs: 5_000,
      pollMs: 10,
      leaseMs: 300,
      run: async () => {
        await appendFile(
          requiredValue(
            process.env.CQ_SINGLE_FLIGHT_PROVIDER_LOG,
            "CQ_SINGLE_FLIGHT_PROVIDER_LOG",
          ),
          `${process.pid.toString()}\n`,
          { mode: 0o600 },
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { contentBundleHash: CONTENT_BUNDLE_HASH } as never;
      },
      toRecord: () => sampleRecord(key),
    });
    expect(["executed", "cached"]).toContain(result.kind);
  });
});

describe.runIf(isWaiterProcessWorker)(
  "single-flight waiter process worker",
  () => {
    test("process waiter worker", async () => {
      const env = {
        CQ_STATE_DIR: requiredValue(process.env.CQ_STATE_DIR, "CQ_STATE_DIR"),
        CQ_CACHE_DIR: requiredValue(process.env.CQ_CACHE_DIR, "CQ_CACHE_DIR"),
      };
      const key = requiredValue(
        process.env.CQ_SINGLE_FLIGHT_KEY,
        "CQ_SINGLE_FLIGHT_KEY",
      );
      await writeFile(
        requiredValue(
          process.env.CQ_SINGLE_FLIGHT_READY,
          "CQ_SINGLE_FLIGHT_READY",
        ),
        "ready\n",
        { mode: 0o600 },
      );
      await waitForPath(
        requiredValue(
          process.env.CQ_SINGLE_FLIGHT_START,
          "CQ_SINGLE_FLIGHT_START",
        ),
        30_000,
      );
      const polledPath = requiredValue(
        process.env.CQ_SINGLE_FLIGHT_POLLED,
        "CQ_SINGLE_FLIGHT_POLLED",
      );
      const waitMs = Number.parseInt(
        requiredValue(
          process.env.CQ_SINGLE_FLIGHT_WAIT_MS,
          "CQ_SINGLE_FLIGHT_WAIT_MS",
        ),
        10,
      );
      const waiterCount = Number.parseInt(
        requiredValue(
          process.env.CQ_SINGLE_FLIGHT_WAITER_COUNT,
          "CQ_SINGLE_FLIGHT_WAITER_COUNT",
        ),
        10,
      );
      const results = await Promise.all(
        Array.from({ length: waiterCount }, async (_, index) => {
          let polled = false;
          const result = await runWithSingleFlight({
            key,
            contentBundleHash: CONTENT_BUNDLE_HASH,
            env,
            waitMs,
            pollMs: 1_000,
            random: () => {
              polled = true;
              writeFileSync(`${polledPath}-${index.toString()}`, "polled\n", {
                mode: 0o600,
              });
              return 0.5;
            },
            run: () => Promise.resolve({} as never),
            toRecord: () => ({}) as never,
          });
          if (result.kind !== "incomplete") {
            throw new Error("Waiter worker returned a non-incomplete result");
          }
          return { polled, reason: result.reason };
        }),
      );
      await writeFile(
        requiredValue(
          process.env.CQ_SINGLE_FLIGHT_RESULT,
          "CQ_SINGLE_FLIGHT_RESULT",
        ),
        `${JSON.stringify({
          polled: results.every((result) => result.polled),
          reason: results.map((result) => result.reason).join("; "),
        })}\n`,
        { mode: 0o600 },
      );
    }, 90_000);
  },
);

async function temporaryEnvironment(
  prefix: string,
): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return { CQ_STATE_DIR: directory, CQ_CACHE_DIR: directory };
}

function sampleRecord(
  cacheKey: string,
  contentBundleHash = CONTENT_BUNDLE_HASH,
): StoredRunRecord {
  return {
    schemaVersion: "1",
    runId: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:01.000Z",
    gate: "PASS",
    reportHash: "2".repeat(64),
    snapshotContentHash: "4".repeat(64),
    contentBundleHash,
    repository: "/tmp/single-flight-test",
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
        repository: "/tmp/single-flight-test",
        head: "1".repeat(40),
        contentHash: "4".repeat(64),
        contentBundleHash,
      },
      policyHash: "3".repeat(64),
      gate: "PASS",
      findingIds: [],
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

function spawnProcessWorker(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly key: string;
  readonly startPath: string;
  readonly providerLog: string;
  readonly readyPath: string;
}): { readonly readyPath: string; readonly done: Promise<number> } {
  const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
  const child = spawn(
    process.execPath,
    [
      vitest,
      "run",
      "tests/unit/review/single-flight.test.ts",
      "-t",
      "process contender worker",
      "--reporter=dot",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...options.env,
        CQ_SINGLE_FLIGHT_PROCESS_WORKER: "1",
        CQ_SINGLE_FLIGHT_KEY: options.key,
        CQ_SINGLE_FLIGHT_START: options.startPath,
        CQ_SINGLE_FLIGHT_READY: options.readyPath,
        CQ_SINGLE_FLIGHT_PROVIDER_LOG: options.providerLog,
      },
      stdio: "ignore",
    },
  );
  const done = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code ?? -1);
    });
  });
  return { readyPath: options.readyPath, done };
}

function spawnWaiterProcessWorker(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly key: string;
  readonly startPath: string;
  readonly readyPath: string;
  readonly resultPath: string;
  readonly polledPath: string;
  readonly waitMs: number;
  readonly waiterCount: number;
}): {
  readonly readyPath: string;
  readonly resultPath: string;
  readonly polledPaths: readonly string[];
  readonly done: Promise<number>;
} {
  const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
  const child = spawn(
    process.execPath,
    [
      vitest,
      "run",
      "tests/unit/review/single-flight.test.ts",
      "-t",
      "process waiter worker",
      "--reporter=dot",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...options.env,
        CQ_SINGLE_FLIGHT_WAITER_WORKER: "1",
        CQ_SINGLE_FLIGHT_KEY: options.key,
        CQ_SINGLE_FLIGHT_START: options.startPath,
        CQ_SINGLE_FLIGHT_READY: options.readyPath,
        CQ_SINGLE_FLIGHT_RESULT: options.resultPath,
        CQ_SINGLE_FLIGHT_POLLED: options.polledPath,
        CQ_SINGLE_FLIGHT_WAIT_MS: options.waitMs.toString(),
        CQ_SINGLE_FLIGHT_WAITER_COUNT: options.waiterCount.toString(),
      },
      stdio: "ignore",
    },
  );
  const done = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code ?? -1);
    });
  });
  return {
    readyPath: options.readyPath,
    resultPath: options.resultPath,
    polledPaths: Array.from(
      { length: options.waiterCount },
      (_, index) => `${options.polledPath}-${index.toString()}`,
    ),
    done,
  };
}

function requiredValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredItem<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function waiterSlotKey(key: string, index: number): string {
  return createHash("sha256")
    .update("cq-review-waiter-slot:v1\0")
    .update(key)
    .update("\0")
    .update(index.toString())
    .digest("hex");
}

async function waitForPath(path: string, waitMs = 5_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForCondition(
  condition: () => boolean,
  waitMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for single-flight condition");
}
