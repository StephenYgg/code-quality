import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { retainReviewTranscript } from "../../../src/storage/transcripts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("transcript retention", () => {
  test("writes redacted 0600 transcript under state dir", async () => {
    const state = await mkdtemp(join(tmpdir(), "cq-tx-"));
    temporaryDirectories.push(state);
    const path = await retainReviewTranscript({
      runId: "00000000-0000-4000-8000-000000000123",
      body: "report Bearer ghp_supersecrettokenvalue123 and ok",
      env: { CQ_STATE_DIR: state },
    });
    const body = await readFile(path, "utf8");
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain("ghp_supersecrettokenvalue123");
  });
});
