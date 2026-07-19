import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { acquireLock, releaseLock } from "../../../src/storage/locks.js";

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
});
