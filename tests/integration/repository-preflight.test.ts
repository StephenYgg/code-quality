import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  collectRepositoryManifest,
  createRepositoryPreflight,
  reconfirmRepository,
  RepositoryManifestError,
} from "../../src/git/repository-manifest.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

const context = {
  policyHash: "a".repeat(64),
  providerClass: "fake",
  endpointClass: "none",
  egressClass: "local",
  budgets: { maxTokens: 1_000, maxDurationMs: 30_000, maxCostUsd: 0 },
};

async function git(
  repository: string,
  args: readonly string[],
): Promise<string> {
  const result = await executeFile(
    "git",
    [
      "--no-pager",
      "-c",
      "user.name=Code Quality Test",
      "-c",
      "user.email=code-quality@example.invalid",
      ...args,
    ],
    {
      cwd: repository,
      encoding: "utf8",
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        PATH: process.env.PATH ?? "",
      },
    },
  );
  return result.stdout.replace(/\n$/u, "");
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "cq-repo-manifest-"));
  temporaryDirectories.push(repository);
  await git(repository, ["init", "--quiet"]);
  return repository;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("full repository preflight", () => {
  test("collects tracked and eligible untracked source without provider calls", async () => {
    const repository = await createRepository();
    await writeFile(
      join(repository, "src.ts"),
      "export const ok = 1;\n",
      "utf8",
    );
    await writeFile(join(repository, "README.md"), "# demo\n", "utf8");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(
      join(repository, "extra.ts"),
      "export const extra = 2;\n",
      "utf8",
    );
    await mkdir(join(repository, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(repository, "node_modules", "pkg", "index.js"),
      "module.exports = 1;\n",
      "utf8",
    );
    await writeFile(join(repository, "image.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(
      join(repository, ".env"),
      "SECRET=abcdefghijklmnopqrstuvwxyz\n",
    );
    await writeFile(join(repository, "ignored.txt"), "nope\n");
    await writeFile(join(repository, ".gitignore"), "ignored.txt\n");

    const capture = await collectRepositoryManifest({ repository }, context);
    const preflight = createRepositoryPreflight(capture, context);

    expect(capture.selected.map((file) => file.path).sort()).toEqual([
      ".gitignore",
      "README.md",
      "extra.ts",
      "src.ts",
    ]);
    expect(
      capture.exclusions.some((item) => item.reason === "dependency"),
    ).toBe(true);
    expect(capture.exclusions.some((item) => item.reason === "binary")).toBe(
      true,
    );
    expect(
      capture.exclusions.some((item) => item.reason === "suspected_secret"),
    ).toBe(true);
    expect(
      capture.exclusions.some((item) => item.reason === "git_ignored"),
    ).toBe(true);
    expect(preflight.selectedFileCount).toBe(4);
    expect(preflight.confirmationHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(preflight.providerClass).toBe("fake");
  });

  test("confirmation rejects stale hashes and accepts matching hashes", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n", "utf8");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const first = await collectRepositoryManifest({ repository }, context);
    await expect(
      reconfirmRepository(first.confirmationHash, { repository }, context),
    ).resolves.toMatchObject({ contentHash: first.contentHash });

    await writeFile(join(repository, "a.ts"), "export const a = 2;\n", "utf8");
    await expect(
      reconfirmRepository(first.confirmationHash, { repository }, context),
    ).rejects.toMatchObject({
      code: "REPOSITORY_CONFIRMATION_MISMATCH",
    } satisfies Partial<RepositoryManifestError>);

    await expect(
      reconfirmRepository("0".repeat(64), { repository }, context),
    ).rejects.toMatchObject({
      code: "REPOSITORY_CONFIRMATION_MISMATCH",
    } satisfies Partial<RepositoryManifestError>);
  });

  test("hard file limits mark the capture incomplete", async () => {
    const repository = await createRepository();
    for (let index = 0; index < 3; index += 1) {
      await writeFile(
        join(repository, `f${String(index)}.ts`),
        `export const n = ${String(index)};\n`,
        "utf8",
      );
    }
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const capture = await collectRepositoryManifest({ repository }, context, {
      maxFiles: 2,
    });
    expect(capture.selected).toHaveLength(2);
    expect(capture.incomplete).toBe(true);
    expect(
      capture.exclusions.some((item) => item.reason === "aggregate_file_limit"),
    ).toBe(true);
  });
});
