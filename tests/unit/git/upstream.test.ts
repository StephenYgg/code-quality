import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { resolveUpstreamRange } from "../../../src/git/upstream.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function git(repository: string, args: readonly string[]): Promise<void> {
  await executeFile("git", [...args], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "cq",
      GIT_AUTHOR_EMAIL: "cq@example.com",
      GIT_COMMITTER_NAME: "cq",
      GIT_COMMITTER_EMAIL: "cq@example.com",
    },
  });
}

describe("upstream range", () => {
  test("resolves merge-base range for a branch with upstream", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-up-"));
    temporaryDirectories.push(repository);
    await git(repository, ["init", "--quiet", "-b", "main"]);
    await writeFile(join(repository, "a.txt"), "a\n");
    await git(repository, ["add", "a.txt"]);
    await git(repository, ["commit", "-m", "base", "--quiet"]);
    await git(repository, ["branch", "feature"]);
    await git(repository, ["checkout", "feature", "--quiet"]);
    await writeFile(join(repository, "b.txt"), "b\n");
    await git(repository, ["add", "b.txt"]);
    await git(repository, ["commit", "-m", "feat", "--quiet"]);
    await git(repository, ["branch", "--set-upstream-to=main", "feature"]);

    const range = await resolveUpstreamRange({ repository });
    expect(range.range).toMatch(/^[0-9a-f]+\.\.[0-9a-f]+$/u);
    expect(range.headSha).toHaveLength(40);
    expect(range.baseSha).toHaveLength(40);
  });
});
