import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  acquireLock,
  type LockDirectoryRename,
  MAX_LOCK_ARTIFACTS_PER_CONTAINER,
  releaseLock,
  renewLock,
} from "../../../src/storage/locks.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("locks", () => {
  test("only one owner can hold a review lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-locks-"));
    temporaryDirectories.push(directory);
    const env = { CQ_STATE_DIR: directory };
    const key = "a".repeat(64);
    const first = await acquireLock(key, { env });
    await expect(acquireLock(key, { env })).rejects.toMatchObject({
      code: "LOCK_BUSY",
    });
    await releaseLock(first);
    const second = await acquireLock(key, { env });
    await releaseLock(second);
  });

  test("only one of 32 contenders reclaims a dead expired owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-locks-race-"));
    temporaryDirectories.push(directory);
    const env = { CQ_STATE_DIR: directory };
    const key = "b".repeat(64);
    const lockDirectory = join(directory, "locks");
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(
      join(lockDirectory, `${key}.lock`),
      `${JSON.stringify({
        owner: "dead-owner",
        expiresAt: 0,
        host: hostname().slice(0, 120),
        shared: false,
        pid: 2_147_483_647,
      })}\n`,
      { mode: 0o600 },
    );

    const attempts = await Promise.allSettled(
      Array.from({ length: 32 }, async () => acquireLock(key, { env })),
    );
    const winners = attempts.flatMap((attempt) =>
      attempt.status === "fulfilled" ? [attempt.value] : [],
    );

    expect(winners).toHaveLength(1);
    await Promise.all(winners.map(releaseLock));
  });

  test("deterministically interleaves 32 reclaim contenders across lifecycle phases", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-controlled-race-",
    );
    const key = "b".repeat(64);
    const root = join(directory, "locks", `${key}.lock`);
    await seedDirectoryLock(directory, key, {
      owner: "controlled-dead-owner",
      expiresAt: 0,
      host: hostname().slice(0, 120),
      pid: 2_147_483_647,
    });
    const phases = createLifecyclePhases();
    const settledPromise = Promise.allSettled(
      Array.from({ length: 32 }, (_, index) =>
        acquireLock(key, {
          env,
          lifecycleBarrier: phases.barrier(index),
        }),
      ),
    );
    let settled: Awaited<typeof settledPromise> | undefined;
    try {
      await phases.waitFor("owner-observed", 32);
      expect(phases.count("generation-guard-acquired")).toBe(0);
      phases.release("owner-observed");

      await phases.waitFor("generation-guard-acquired", 1);
      expect((await readdir(root)).length).toBeLessThanOrEqual(
        MAX_LOCK_ARTIFACTS_PER_CONTAINER,
      );
      phases.release("generation-guard-acquired");

      await phases.waitFor("owner-quarantined", 1);
      const quarantined = await readdir(root);
      expect(quarantined).not.toContain("owner");
      expect(quarantined.some((name) => name.startsWith(".quarantine-"))).toBe(
        true,
      );
      expect(quarantined.length).toBeLessThanOrEqual(
        MAX_LOCK_ARTIFACTS_PER_CONTAINER,
      );
      phases.release("owner-quarantined");

      await phases.waitFor("owner-installed", 1);
      const installed = await readdir(root);
      expect(installed).toContain("owner");
      expect(installed.length).toBeLessThanOrEqual(
        MAX_LOCK_ARTIFACTS_PER_CONTAINER,
      );
      phases.release("owner-installed");

      settled = await settledPromise;
      const winners = settled.flatMap((attempt) =>
        attempt.status === "fulfilled" ? [attempt.value] : [],
      );
      expect(winners).toHaveLength(1);
      expect(phases.count("owner-quarantined")).toBe(1);
      expect(phases.count("owner-installed")).toBe(1);
      expect((await readdir(root)).length).toBeLessThanOrEqual(
        MAX_LOCK_ARTIFACTS_PER_CONTAINER,
      );
      await Promise.all(winners.map(releaseLock));
    } finally {
      phases.releaseAll();
      settled ??= await settledPromise;
      await Promise.all(
        settled.flatMap((attempt) =>
          attempt.status === "fulfilled" ? [releaseLock(attempt.value)] : [],
        ),
      );
    }
  });

  test("only one of 32 contenders replaces a crash-empty owner directory", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-empty-owner-",
    );
    const key = "1".repeat(64);
    await mkdir(join(directory, "locks", `${key}.lock`, "owner"), {
      recursive: true,
      mode: 0o700,
    });

    const attempts = await Promise.allSettled(
      Array.from({ length: 32 }, async () => acquireLock(key, { env })),
    );
    const winners = attempts.flatMap((attempt) =>
      attempt.status === "fulfilled" ? [attempt.value] : [],
    );

    expect(winners).toHaveLength(1);
    await Promise.all(winners.map(releaseLock));
  });

  test("recovers an empty owner when directory rename cannot replace it", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-windows-empty-owner-",
    );
    const key = "9".repeat(64);
    await mkdir(join(directory, "locks", `${key}.lock`, "owner"), {
      recursive: true,
      mode: 0o700,
    });

    const attempts = await Promise.allSettled(
      Array.from({ length: 32 }, async () =>
        acquireLock(key, { env, directoryRename: windowsDirectoryRename }),
      ),
    );
    const winners = attempts.flatMap((attempt) =>
      attempt.status === "fulfilled" ? [attempt.value] : [],
    );

    expect(winners).toHaveLength(1);
    await Promise.all(winners.map(releaseLock));
  });

  test("only one of 32 contenders reclaims a local-dead generation guard", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-dead-guard-",
    );
    const key = "2".repeat(64);
    const owner = "dead-owner-with-guard";
    await seedDirectoryLock(directory, key, {
      owner,
      expiresAt: 0,
      host: hostname().slice(0, 120),
      pid: 2_147_483_647,
    });
    const guard = join(
      directory,
      "locks",
      `${key}.lock`,
      `.operation-${createHash("sha256").update(owner).digest("hex").slice(0, 24)}`,
    );
    await mkdir(guard, { mode: 0o700 });
    await writeFile(
      join(guard, "guard.json"),
      `${JSON.stringify({
        token: "dead-guard",
        owner,
        host: hostname().slice(0, 120),
        pid: 2_147_483_647,
      })}\n`,
      { mode: 0o600 },
    );

    const attempts = await Promise.allSettled(
      Array.from({ length: 32 }, async () => acquireLock(key, { env })),
    );
    const winners = attempts.flatMap((attempt) =>
      attempt.status === "fulfilled" ? [attempt.value] : [],
    );

    expect(winners).toHaveLength(1);
    await Promise.all(winners.map(releaseLock));
  });

  test("recovers an empty guard when directory rename cannot replace it", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-windows-empty-guard-",
    );
    const key = "a".repeat(64);
    const owner = "dead-owner-with-empty-guard";
    await seedDirectoryLock(directory, key, {
      owner,
      expiresAt: 0,
      host: hostname().slice(0, 120),
      pid: 2_147_483_647,
    });
    const guard = join(
      directory,
      "locks",
      `${key}.lock`,
      `.operation-${createHash("sha256").update(owner).digest("hex").slice(0, 24)}`,
    );
    await mkdir(guard, { mode: 0o700 });

    const attempts = await Promise.allSettled(
      Array.from({ length: 32 }, async () =>
        acquireLock(key, { env, directoryRename: windowsDirectoryRename }),
      ),
    );
    const winners = attempts.flatMap((attempt) =>
      attempt.status === "fulfilled" ? [attempt.value] : [],
    );

    expect(winners).toHaveLength(1);
    await Promise.all(winners.map(releaseLock));
  });

  test("never reclaims an expired owner while its local PID is alive", async () => {
    const { env } = await temporaryLockEnvironment("cq-locks-live-");
    const key = "c".repeat(64);
    const owner = await acquireLock(key, { env, ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(acquireLock(key, { env })).rejects.toMatchObject({
      code: "LOCK_BUSY",
    });
    await releaseLock(owner);
  });

  test("does not reclaim an expired owner from an unknown remote host", async () => {
    const { directory, env } =
      await temporaryLockEnvironment("cq-locks-remote-");
    const key = "d".repeat(64);
    await seedDirectoryLock(directory, key, {
      owner: "remote-owner",
      expiresAt: 0,
      host: "other-host.invalid",
      pid: 2_147_483_647,
    });

    await expect(acquireLock(key, { env })).rejects.toMatchObject({
      code: "LOCK_BUSY",
    });
  });

  test("does not reclaim an unknown remote generation guard", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-remote-guard-",
    );
    const key = "3".repeat(64);
    const owner = "dead-owner-with-remote-guard";
    await seedDirectoryLock(directory, key, {
      owner,
      expiresAt: 0,
      host: hostname().slice(0, 120),
      pid: 2_147_483_647,
    });
    const guard = join(
      directory,
      "locks",
      `${key}.lock`,
      `.operation-${createHash("sha256").update(owner).digest("hex").slice(0, 24)}`,
    );
    await mkdir(guard, { mode: 0o700 });
    await writeFile(
      join(guard, "guard.json"),
      `${JSON.stringify({
        token: "remote-guard",
        owner,
        host: "other-host.invalid",
        pid: 2_147_483_647,
      })}\n`,
      { mode: 0o600 },
    );

    await expect(acquireLock(key, { env })).rejects.toMatchObject({
      code: "LOCK_BUSY",
    });
    await expect(stat(guard)).resolves.toBeDefined();
  });

  test("removes only a bounded number of local-dead prepared artifacts", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-dead-artifacts-",
    );
    const key = "4".repeat(64);
    const root = join(directory, "locks", `${key}.lock`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 40; index += 1) {
      const artifact = join(root, `.owner-dead-${index.toString()}.prepared`);
      await mkdir(artifact, { mode: 0o700 });
      await writeFile(
        join(artifact, "lease.json"),
        `${JSON.stringify({
          owner: `dead-${index.toString()}`,
          expiresAt: 0,
          host: hostname().slice(0, 120),
          pid: 2_147_483_647,
        })}\n`,
        { mode: 0o600 },
      );
    }

    const acquired = await acquireLock(key, { env });
    const remaining = (await readdir(root)).filter((name) =>
      name.endsWith(".prepared"),
    );
    expect(remaining).toHaveLength(8);
    await releaseLock(acquired);
  });

  test("removes a local-dead prepared generation guard", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-dead-prepared-guard-",
    );
    const key = "5".repeat(64);
    const root = join(directory, "locks", `${key}.lock`);
    const artifact = join(root, ".operation-dead.prepared-dead-token");
    await mkdir(artifact, { recursive: true, mode: 0o700 });
    await writeFile(
      join(artifact, "guard.json"),
      `${JSON.stringify({
        token: "dead-token",
        owner: "dead-owner",
        host: hostname().slice(0, 120),
        pid: 2_147_483_647,
      })}\n`,
      { mode: 0o600 },
    );

    const acquired = await acquireLock(key, { env });
    await releaseLock(acquired);

    await expect(stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("removes old payload-less owner and guard prepared artifacts", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-empty-prepared-",
    );
    const key = "6".repeat(64);
    const root = join(directory, "locks", `${key}.lock`);
    const ownerArtifact = join(root, ".owner-crashed.prepared");
    const guardArtifact = join(root, ".operation-crashed.prepared-token");
    await mkdir(ownerArtifact, { recursive: true, mode: 0o700 });
    await mkdir(guardArtifact, { mode: 0o700 });
    const stale = new Date(Date.now() - 120_000);
    await utimes(ownerArtifact, stale, stale);
    await utimes(guardArtifact, stale, stale);

    const acquired = await acquireLock(key, { env });
    await releaseLock(acquired);

    await expect(stat(ownerArtifact)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(guardArtifact)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects unique lock growth when bounded cleanup cannot restore capacity", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-global-capacity-",
    );
    const locks = join(directory, "locks");
    await mkdir(locks, { mode: 0o700 });
    const stale = new Date(Date.now() - 120_000);
    for (let index = 0; index < 1_057; index += 1) {
      const root = join(locks, `${index.toString(16).padStart(64, "0")}.lock`);
      await mkdir(root, { mode: 0o700 });
      await utimes(root, stale, stale);
    }
    const remoteRoot = join(locks, `${"0".repeat(64)}.lock`);
    const remoteArtifact = join(remoteRoot, ".owner-remote.prepared");
    const remoteStale = new Date(Date.now() - 240_000);
    await mkdir(remoteArtifact, { mode: 0o700 });
    await writeFile(
      join(remoteArtifact, "lease.json"),
      `${JSON.stringify({
        owner: "remote-prepared-owner",
        expiresAt: 0,
        host: "other-host.invalid",
        pid: 2_147_483_647,
      })}\n`,
      { mode: 0o600 },
    );
    await utimes(remoteArtifact, remoteStale, remoteStale);
    await utimes(remoteRoot, remoteStale, remoteStale);
    const key = "7".repeat(64);

    await expect(acquireLock(key, { env })).rejects.toMatchObject({
      code: "LOCK_CAPACITY_EXCEEDED",
    });

    const remaining = (await readdir(locks)).filter((name) =>
      name.endsWith(".lock"),
    );
    expect(remaining).toHaveLength(1_025);
    expect(remaining).not.toContain(`${key}.lock`);
    await expect(stat(remoteRoot)).resolves.toBeDefined();
  });

  test("rejects owner growth when one lock container remains over capacity", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-container-capacity-",
    );
    const key = "8".repeat(64);
    const root = join(directory, "locks", `${key}.lock`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stale = new Date(Date.now() - 120_000);
    for (let index = 0; index < 161; index += 1) {
      const artifact = join(root, `.owner-dead-${index.toString()}.prepared`);
      await mkdir(artifact, { mode: 0o700 });
      await utimes(artifact, stale, stale);
    }

    await expect(acquireLock(key, { env })).rejects.toMatchObject({
      code: "LOCK_CAPACITY_EXCEEDED",
    });

    const remaining = await readdir(root);
    expect(remaining).toHaveLength(129);
    expect(remaining).not.toContain("owner");
  });

  test("repeated crash recovery attempts cannot grow an exact-capacity container", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-exact-container-capacity-",
    );
    const key = "0".repeat(64);
    const root = join(directory, "locks", `${key}.lock`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await seedRecentCrashArtifacts(root, MAX_LOCK_ARTIFACTS_PER_CONTAINER);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(acquireLock(key, { env })).rejects.toMatchObject({
        code: "LOCK_CAPACITY_EXCEEDED",
      });
      await expect(readdir(root)).resolves.toHaveLength(
        MAX_LOCK_ARTIFACTS_PER_CONTAINER,
      );
    }
  });

  test("dead-owner reclaim reserves guard and owner artifacts before acting", async () => {
    const { directory, env } = await temporaryLockEnvironment(
      "cq-locks-reclaim-capacity-",
    );
    const key = "1".repeat(64);
    const root = join(directory, "locks", `${key}.lock`);
    await seedDirectoryLock(directory, key, {
      owner: "dead-capacity-owner",
      expiresAt: 0,
      host: hostname().slice(0, 120),
      pid: 2_147_483_647,
    });
    await seedRecentCrashArtifacts(root, MAX_LOCK_ARTIFACTS_PER_CONTAINER - 1);

    await expect(acquireLock(key, { env })).rejects.toMatchObject({
      code: "LOCK_CAPACITY_EXCEEDED",
    });
    const remaining = await readdir(root);
    expect(remaining).toHaveLength(MAX_LOCK_ARTIFACTS_PER_CONTAINER);
    expect(remaining).toContain("owner");
    expect(remaining.some((name) => name.startsWith(".operation-"))).toBe(
      false,
    );
    expect(remaining.some((name) => name.startsWith(".quarantine-"))).toBe(
      false,
    );
  });

  test("renew reserves generation artifacts before acting", async () => {
    const { env } = await temporaryLockEnvironment("cq-locks-renew-capacity-");
    const key = "2".repeat(64);
    const owner = await acquireLock(key, { env });
    await seedRecentCrashArtifacts(
      owner.path,
      MAX_LOCK_ARTIFACTS_PER_CONTAINER - 1,
    );

    await expect(renewLock(owner)).rejects.toMatchObject({
      code: "LOCK_CAPACITY_EXCEEDED",
    });
    expect(await readdir(owner.path)).toHaveLength(
      MAX_LOCK_ARTIFACTS_PER_CONTAINER,
    );
    await rm(owner.path, { force: true, recursive: true });
  });

  test("release reserves generation artifacts before retiring its owner", async () => {
    const { env } = await temporaryLockEnvironment(
      "cq-locks-release-capacity-",
    );
    const key = "3".repeat(64);
    const owner = await acquireLock(key, { env });
    await seedRecentCrashArtifacts(
      owner.path,
      MAX_LOCK_ARTIFACTS_PER_CONTAINER - 1,
    );

    await expect(releaseLock(owner)).rejects.toMatchObject({
      code: "LOCK_CAPACITY_EXCEEDED",
    });
    const remaining = await readdir(owner.path);
    expect(remaining).toHaveLength(MAX_LOCK_ARTIFACTS_PER_CONTAINER);
    expect(remaining).toContain("owner");
    expect(remaining.some((name) => name.startsWith(".quarantine-"))).toBe(
      false,
    );
    await rm(owner.path, { force: true, recursive: true });
  });

  test("an old owner cannot renew or release its successor", async () => {
    const { env } = await temporaryLockEnvironment("cq-locks-successor-");
    const key = "e".repeat(64);
    const oldOwner = await acquireLock(key, { env });
    const leasePath = join(oldOwner.path, "owner", "lease.json");
    const lease = JSON.parse(await readFile(leasePath, "utf8")) as object;
    await writeFile(
      leasePath,
      `${JSON.stringify({
        ...lease,
        expiresAt: 0,
        pid: 2_147_483_647,
      })}\n`,
      { mode: 0o600 },
    );
    const successor = await acquireLock(key, { env });

    await expect(renewLock(oldOwner)).rejects.toMatchObject({
      code: "LOCK_NOT_OWNED",
    });
    await expect(releaseLock(oldOwner)).rejects.toMatchObject({
      code: "LOCK_NOT_OWNED",
    });
    await expect(acquireLock(key, { env })).rejects.toMatchObject({
      code: "LOCK_BUSY",
    });
    await releaseLock(successor);
  });

  test("creates permission-restricted lock directories and lease files", async () => {
    const { env } = await temporaryLockEnvironment("cq-locks-mode-");
    const owner = await acquireLock("f".repeat(64), { env });

    expect((await stat(owner.path)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(owner.path, "owner", "lease.json"))).mode & 0o777,
    ).toBe(0o600);
    await releaseLock(owner);
  });
});

async function temporaryLockEnvironment(prefix: string): Promise<{
  readonly directory: string;
  readonly env: NodeJS.ProcessEnv;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return { directory, env: { CQ_STATE_DIR: directory } };
}

async function seedDirectoryLock(
  stateDirectory: string,
  key: string,
  payload: object,
): Promise<void> {
  const ownerDirectory = join(stateDirectory, "locks", `${key}.lock`, "owner");
  await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(ownerDirectory, "lease.json"),
    `${JSON.stringify(payload)}\n`,
    { mode: 0o600 },
  );
}

async function seedRecentCrashArtifacts(
  root: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await mkdir(join(root, `.owner-crash-${index.toString()}.prepared`), {
      mode: 0o700,
    });
  }
}

const windowsDirectoryRename: LockDirectoryRename = async (source, target) => {
  try {
    await stat(target);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      await rename(source, target);
      return;
    }
    throw error;
  }
  const error = new Error("Windows directory rename target exists");
  Object.assign(error, { code: "EEXIST" });
  throw error;
};

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

type LockLifecyclePhase =
  | "owner-observed"
  | "generation-guard-acquired"
  | "owner-quarantined"
  | "owner-installed";

function createLifecyclePhases(): {
  readonly barrier: (
    contender: number,
  ) => (phase: LockLifecyclePhase) => Promise<void>;
  readonly count: (phase: LockLifecyclePhase) => number;
  readonly waitFor: (phase: LockLifecyclePhase, count: number) => Promise<void>;
  readonly release: (phase: LockLifecyclePhase) => void;
  readonly releaseAll: () => void;
} {
  const arrivals = new Map<LockLifecyclePhase, Set<number>>();
  const releases = new Map<LockLifecyclePhase, () => void>();
  const releasePromises = new Map<LockLifecyclePhase, Promise<void>>();
  const releaseFor = (phase: LockLifecyclePhase): Promise<void> => {
    const existing = releasePromises.get(phase);
    if (existing !== undefined) return existing;
    const promise = new Promise<void>((resolve) => {
      releases.set(phase, resolve);
    });
    releasePromises.set(phase, promise);
    return promise;
  };
  const release = (phase: LockLifecyclePhase): void => {
    releases.get(phase)?.();
  };
  return {
    barrier: (contender) => async (phase) => {
      const phaseArrivals = arrivals.get(phase) ?? new Set<number>();
      phaseArrivals.add(contender);
      arrivals.set(phase, phaseArrivals);
      await releaseFor(phase);
    },
    count: (phase) => arrivals.get(phase)?.size ?? 0,
    waitFor: async (phase, count) => {
      await waitForTestCondition(
        () => (arrivals.get(phase)?.size ?? 0) >= count,
      );
    },
    release,
    releaseAll: () => {
      for (const phase of [
        "owner-observed",
        "generation-guard-acquired",
        "owner-quarantined",
        "owner-installed",
      ] as const) {
        release(phase);
      }
    },
  };
}

async function waitForTestCondition(
  condition: () => boolean,
  waitMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for lock lifecycle phase");
}
