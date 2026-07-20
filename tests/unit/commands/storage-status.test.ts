import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runStorageStatusCommand } from "../../../src/commands/storage-status.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("storage status", () => {
  test("reports local-only coordination and bounded per-host waiters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-storage-status-"));
    temporaryDirectories.push(directory);

    const result = await runStorageStatusCommand({
      env: { CQ_STATE_DIR: directory, CQ_CACHE_DIR: directory },
    });

    expect(result.output).toContain("sharedPathEnv (placement only)");
    expect(result.output).toContain("crossMachineFencing: unsupported");
    expect(result.output).toContain("localWaitersPerKeyPerHost: 64");
    expect(result.output).toContain("singleFlightWaitCeilingMs: 60000");
  });
});
