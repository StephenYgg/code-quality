import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { createImmutableReviewInput } from "../../src/core/review-input.js";
import { createReviewSnapshot } from "../../src/core/snapshots.js";
import { resolveTrustedGitExecution } from "../../src/git/commands.js";
import { captureContentEntries } from "../../src/git/content-capture.js";
import {
  captureLocalGitInput,
  captureLocalGitReviewInput,
  GitInputError,
  type LocalGitInputIo,
} from "../../src/git/inputs.js";
import { collectReviewContext } from "../../src/review/context.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

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
  const repository = await mkdtemp(join(tmpdir(), "cq-git-input-"));
  temporaryDirectories.push(repository);
  await git(repository, ["init", "--quiet"]);
  return repository;
}

async function commitAll(repository: string, message: string): Promise<string> {
  await git(repository, ["add", "--all", "--"]);
  await git(repository, ["commit", "--quiet", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("local Git input snapshots", () => {
  test("captures a deterministic frozen worktree snapshot with unusual paths", async () => {
    const repository = await createRepository();
    const trackedPaths = [
      "-leading.txt",
      "line\nbreak.txt",
      "normal.txt",
      "你好.txt",
    ];
    for (const path of trackedPaths) {
      await writeFile(join(repository, path), `initial:${path}`, "utf8");
    }
    const base = await commitAll(repository, "initial");
    for (const path of trackedPaths) {
      await writeFile(join(repository, path), `changed:${path}`, "utf8");
    }
    const untracked = "untracked\nfile.txt";
    await writeFile(join(repository, untracked), "not included", "utf8");

    const first = await captureLocalGitInput({ repository, worktree: true });
    const second = await captureLocalGitInput({ repository, worktree: true });

    expect(first.inputKind).toBe("worktree");
    expect(first.scope).toBe("change");
    expect(first.comparisonBase).toBe(base);
    expect(first.files.map((file) => file.path)).toEqual(
      [...trackedPaths, untracked].sort(),
    );
    expect(first.files).toContainEqual(
      expect.objectContaining({ path: untracked, status: "added" }),
    );
    expect(first.exclusions).not.toContainEqual(
      expect.objectContaining({ path: untracked }),
    );
    expect(first.incomplete).toBe(false);
    expect(first.contentHash).toBe(second.contentHash);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.files)).toBe(true);
    expect(Object.isFrozen(first.files[0])).toBe(true);
    expect(Reflect.set(first.files[0] ?? {}, "path", "mutated")).toBe(false);
  });

  test("captures normal worktree bytes on macOS without a resolvable fd link", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.txt");
    await writeFile(path, "base\n", "utf8");
    await commitAll(repository, "initial");
    await writeFile(path, "worktree bytes\n", "utf8");

    const input = await captureLocalGitReviewInput({
      repository,
      worktree: true,
    });

    expect(input.contentByPath.get("value.txt")?.toString("utf8")).toBe(
      "worktree bytes\n",
    );
  });

  test("captures eligible untracked text as an added review file", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "tracked.ts"), "export const base = 1;\n");
    await commitAll(repository, "initial");
    await writeFile(
      join(repository, "untracked.ts"),
      "export const untracked = true;\n",
    );

    const input = await captureLocalGitReviewInput({
      repository,
      worktree: true,
    });

    expect(input.snapshot.files).toContainEqual(
      expect.objectContaining({
        path: "untracked.ts",
        status: "added",
        binary: false,
      }),
    );
    expect(input.snapshot.exclusions).not.toContainEqual(
      expect.objectContaining({ path: "untracked.ts" }),
    );
    expect(input.contentByPath.get("untracked.ts")?.toString("utf8")).toBe(
      "export const untracked = true;\n",
    );
  });

  test("excludes unsafe untracked content with path-scoped reasons", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "tracked.ts"), "export const base = 1;\n");
    await commitAll(repository, "initial");
    await writeFile(join(repository, "binary.dat"), Buffer.from([0, 1, 2]));
    await writeFile(join(repository, "invalid.ts"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(repository, ".env.local"), "TOKEN=not-for-review\n");
    await writeFile(
      join(repository, "credential.ts"),
      'export const apiKey = "abcdefghijklmnopqrstuvwxyz";\n',
    );

    const input = await captureLocalGitReviewInput({
      repository,
      worktree: true,
    });

    expect(input.snapshot.exclusions).toEqual(
      expect.arrayContaining([
        { path: ".env.local", reason: "suspected_secret" },
        { path: "binary.dat", reason: "binary" },
        { path: "credential.ts", reason: "suspected_secret" },
        { path: "invalid.ts", reason: "unsupported" },
      ]),
    );
    for (const path of [
      ".env.local",
      "binary.dat",
      "credential.ts",
      "invalid.ts",
    ]) {
      expect(input.contentByPath.has(path)).toBe(false);
    }
    expect(input.snapshot.incomplete).toBe(true);
  });

  test("rejects same-path untracked content mutation across 20 interleavings", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "tracked.ts"), "export const base = 1;\n");
    await commitAll(repository, "initial");
    const path = join(repository, "untracked.ts");
    for (let iteration = 0; iteration < 20; iteration += 1) {
      await writeFile(path, `export const value = ${String(iteration * 2)};\n`);
      const io: LocalGitInputIo = {
        beforeSourceVerification: async () => {
          await writeFile(
            path,
            `export const value = ${String(iteration * 2 + 1)};\n`,
          );
        },
      };

      await expect(
        captureLocalGitReviewInput({ repository, worktree: true }, io),
      ).rejects.toMatchObject({ code: "GIT_SOURCE_STALE" });
    }
  }, 15_000);

  test("marks files beyond the local content cap with path exclusions", async () => {
    const repository = await createRepository();
    for (let index = 0; index <= 40; index += 1) {
      await writeFile(
        join(repository, `f${String(index).padStart(2, "0")}.ts`),
        `export const value = ${String(index)};\n`,
      );
    }
    await commitAll(repository, "initial");
    for (let index = 0; index <= 40; index += 1) {
      await writeFile(
        join(repository, `f${String(index).padStart(2, "0")}.ts`),
        `export const value = ${String(index + 1)};\n`,
      );
    }

    const input = await captureLocalGitReviewInput({
      repository,
      worktree: true,
    });

    expect(input.snapshot.files).toHaveLength(41);
    expect(input.contentByPath.size).toBe(40);
    expect(input.snapshot.exclusions).toContainEqual({
      path: "f40.ts",
      reason: "file_limit",
    });
    expect(input.snapshot.incomplete).toBe(true);
  });

  test("omits an entire file that exceeds the local per-file byte cap", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "large.txt"), "small\n");
    await commitAll(repository, "initial");
    await writeFile(join(repository, "large.txt"), "x".repeat(70 * 1024));

    const input = await captureLocalGitReviewInput({
      repository,
      worktree: true,
    });

    expect(input.contentByPath.has("large.txt")).toBe(false);
    expect(input.snapshot.exclusions).toContainEqual({
      path: "large.txt",
      reason: "file_limit",
    });
    expect(input.snapshot.incomplete).toBe(true);
  });

  test("accepts 64 KiB files and wholly omits 64 KiB plus one byte", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "accepted.txt"), "small\n");
    await writeFile(join(repository, "over-limit.txt"), "small\n");
    await commitAll(repository, "initial");
    await writeFile(join(repository, "accepted.txt"), "a".repeat(64 * 1024));
    await writeFile(
      join(repository, "over-limit.txt"),
      "b".repeat(64 * 1024 + 1),
    );

    const input = await captureLocalGitReviewInput({
      repository,
      worktree: true,
    });

    expect(input.contentByPath.get("accepted.txt")?.length).toBe(64 * 1024);
    expect(input.contentByPath.has("over-limit.txt")).toBe(false);
    expect(input.snapshot.exclusions).toContainEqual({
      path: "over-limit.txt",
      reason: "file_limit",
    });
    expect(input.snapshot.incomplete).toBe(true);
  });

  test("omits whole files after the local aggregate byte cap", async () => {
    const repository = await createRepository();
    for (let index = 0; index < 9; index += 1) {
      await writeFile(
        join(repository, `large-${String(index)}.txt`),
        `base ${String(index)}\n`,
      );
    }
    await commitAll(repository, "initial");
    for (let index = 0; index < 9; index += 1) {
      await writeFile(
        join(repository, `large-${String(index)}.txt`),
        String(index).repeat(index < 8 ? 64 * 1024 : 20),
      );
    }

    const input = await captureLocalGitReviewInput({
      repository,
      worktree: true,
    });

    expect(input.contentByPath.size).toBe(8);
    expect(input.contentByPath.has("large-8.txt")).toBe(false);
    expect(input.snapshot.exclusions).toContainEqual({
      path: "large-8.txt",
      reason: "aggregate_byte_limit",
    });
    expect(input.snapshot.incomplete).toBe(true);
    expect(
      [...input.contentByPath.values()].reduce(
        (total, bytes) => total + bytes.length,
        0,
      ),
    ).toBe(512 * 1024);
  });

  test("captures staged rename and binary metadata", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "old-name.txt"), "rename me\n", "utf8");
    await writeFile(join(repository, "image.bin"), Buffer.from([0, 1, 2]));
    const base = await commitAll(repository, "initial");
    await git(repository, ["mv", "--", "old-name.txt", "new-name.txt"]);
    await writeFile(join(repository, "image.bin"), Buffer.from([0, 1, 3]));
    await git(repository, ["add", "--all", "--"]);

    const snapshot = await captureLocalGitInput({ repository, staged: true });

    expect(snapshot.inputKind).toBe("staged");
    expect(snapshot.comparisonBase).toBe(base);
    expect(snapshot.incomplete).toBe(false);
    expect(snapshot.files).toContainEqual(
      expect.objectContaining({
        path: "new-name.txt",
        previousPath: "old-name.txt",
        status: "renamed",
      }),
    );
    expect(snapshot.files).toContainEqual(
      expect.objectContaining({ path: "image.bin", binary: true }),
    );
  });

  test("captures staged index bytes instead of unstaged worktree bytes", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.txt");
    await writeFile(path, "base\n", "utf8");
    await commitAll(repository, "initial");
    await writeFile(path, "staged\n", "utf8");
    await git(repository, ["add", "--", "value.txt"]);
    await writeFile(path, "unstaged\n", "utf8");

    const input = await captureLocalGitReviewInput({
      repository,
      staged: true,
    });
    const context = await collectReviewContext(input.snapshot, {
      contentByPath: input.contentByPath,
    });

    expect(context.files).toContainEqual(
      expect.objectContaining({ path: "value.txt", content: "staged\n" }),
    );
  });

  test("resolves commit and range selectors to object IDs", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "value.txt"), "one\n", "utf8");
    const first = await commitAll(repository, "first");
    await writeFile(join(repository, "value.txt"), "two\n", "utf8");
    const second = await commitAll(repository, "second");
    await writeFile(join(repository, "other.txt"), "three\n", "utf8");
    const third = await commitAll(repository, "third");

    const commit = await captureLocalGitInput({
      repository,
      commit: second,
    });
    const range = await captureLocalGitInput({
      repository,
      range: `${first}..${third}`,
    });

    expect(commit).toMatchObject({
      inputKind: "commit",
      comparisonBase: first,
      head: second,
    });
    expect(commit.files.map((file) => file.path)).toEqual(["value.txt"]);
    expect(range).toMatchObject({
      inputKind: "range",
      comparisonBase: first,
      head: third,
    });
    expect(range.files.map((file) => file.path)).toEqual([
      "other.txt",
      "value.txt",
    ]);
  });

  test("captures old commit and range bytes from their resolved head object", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.txt");
    await writeFile(path, "base\n", "utf8");
    const first = await commitAll(repository, "first");
    await writeFile(path, "target\n", "utf8");
    const target = await commitAll(repository, "target");
    await writeFile(path, "current head\n", "utf8");
    await commitAll(repository, "current");

    const inputs = await Promise.all([
      captureLocalGitReviewInput({ repository, commit: target }),
      captureLocalGitReviewInput({ repository, range: `${first}..${target}` }),
    ]);
    const contexts = await Promise.all(
      inputs.map((input) =>
        collectReviewContext(input.snapshot, {
          contentByPath: input.contentByPath,
        }),
      ),
    );

    expect(contexts.map((context) => context.files[0]?.content)).toEqual([
      "target\n",
      "target\n",
    ]);
  });

  test("rejects worktree replacement after snapshot enumeration", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.txt");
    await writeFile(path, "base\n", "utf8");
    await commitAll(repository, "initial");
    await writeFile(path, "captured candidate\n", "utf8");
    const io: LocalGitInputIo = {
      beforeContentCapture: async () =>
        writeFile(path, "replacement\n", "utf8"),
    };

    await expect(
      captureLocalGitReviewInput({ repository, worktree: true }, io),
    ).rejects.toMatchObject({ code: "GIT_SOURCE_STALE" });
  });

  test("rejects same-byte inode replacement after snapshot enumeration", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.txt");
    await writeFile(path, "base\n", "utf8");
    await commitAll(repository, "initial");
    await writeFile(path, "candidate\n", "utf8");
    const outside = await mkdtemp(join(tmpdir(), "cq-inode-replacement-"));
    temporaryDirectories.push(outside);
    const io: LocalGitInputIo = {
      beforeContentCapture: async () => {
        await rename(path, join(outside, "replaced-value.txt"));
        await writeFile(path, "candidate\n", "utf8");
      },
    };

    await expect(
      captureLocalGitReviewInput({ repository, worktree: true }, io),
    ).rejects.toMatchObject({ code: "GIT_SOURCE_STALE" });
  });

  test("rejects same-byte parent directory replacement", async () => {
    const repository = await createRepository();
    const directory = join(repository, "src");
    await mkdir(directory);
    const path = join(directory, "value.txt");
    await writeFile(path, "base\n", "utf8");
    await commitAll(repository, "initial");
    await writeFile(path, "candidate\n", "utf8");
    const outside = await mkdtemp(join(tmpdir(), "cq-parent-replacement-"));
    temporaryDirectories.push(outside);
    const io: LocalGitInputIo = {
      beforeContentCapture: async () => {
        await rename(directory, join(outside, "replaced-src"));
        await mkdir(directory);
        await writeFile(path, "candidate\n", "utf8");
      },
    };

    await expect(
      captureLocalGitReviewInput({ repository, worktree: true }, io),
    ).rejects.toMatchObject({ code: "GIT_SOURCE_STALE" });
  });

  test("fails closed when a parent symlink points outside the repository", async () => {
    const repository = await createRepository();
    const outside = await mkdtemp(join(tmpdir(), "cq-external-sentinel-"));
    temporaryDirectories.push(outside);
    await writeFile(
      join(outside, "sentinel.txt"),
      "must not enter provider context\n",
      "utf8",
    );
    await symlink(outside, join(repository, "linked"), "dir");
    const snapshot = createReviewSnapshot({
      inputKind: "worktree",
      scope: "change",
      repository,
      head: "f".repeat(64),
      files: [
        {
          path: "linked/sentinel.txt",
          status: "modified",
          binary: false,
        },
      ],
      exclusions: [],
      incomplete: false,
    });
    const capture = await captureContentEntries({
      repository,
      kind: "worktree",
      files: snapshot.files,
      execution: await resolveTrustedGitExecution(repository),
    });
    const normalizedSnapshot = createReviewSnapshot({
      ...snapshot,
      exclusions: capture.omissions,
      incomplete: capture.omissions.length > 0,
    });
    const input = createImmutableReviewInput(
      normalizedSnapshot,
      capture.captured,
    );

    const context = await collectReviewContext(input.snapshot, {
      contentByPath: input.contentByPath,
    });

    expect(input.contentByPath.has("linked/sentinel.txt")).toBe(false);
    expect(input.snapshot.exclusions).toContainEqual({
      path: "linked/sentinel.txt",
      reason: "symlink",
    });
    expect(context.files).toEqual([]);
    expect(context.exclusions).toEqual(["linked/sentinel.txt"]);
    expect(context.incomplete).toBe(true);
  });

  test("rejects ambiguous selectors and invalid revisions", async () => {
    const repository = await createRepository();

    await expect(
      captureLocalGitInput({ repository, worktree: true, staged: true }),
    ).rejects.toMatchObject({
      code: "GIT_SELECTOR_INVALID",
    } satisfies Partial<GitInputError>);
    await expect(
      captureLocalGitInput({ repository, commit: "missing-revision" }),
    ).rejects.toMatchObject({
      code: "GIT_REVISION_INVALID",
    } satisfies Partial<GitInputError>);
  });

  test("rejects worktree mutation during collection", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.txt");
    await writeFile(path, "one\n", "utf8");
    await commitAll(repository, "initial");
    await writeFile(path, "two\n", "utf8");
    const io: LocalGitInputIo = {
      beforeSourceVerification: async () => writeFile(path, "three\n", "utf8"),
    };

    await expect(
      captureLocalGitInput({ repository, worktree: true }, io),
    ).rejects.toMatchObject({ code: "GIT_SOURCE_STALE" });
  });

  test("rejects index mutation during staged collection", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.txt");
    await writeFile(path, "one\n", "utf8");
    await commitAll(repository, "initial");
    await writeFile(path, "two\n", "utf8");
    await git(repository, ["add", "--", "value.txt"]);
    const io: LocalGitInputIo = {
      beforeSourceVerification: async () => {
        await writeFile(path, "three\n", "utf8");
        await git(repository, ["add", "--", "value.txt"]);
      },
    };

    await expect(
      captureLocalGitInput({ repository, staged: true }, io),
    ).rejects.toMatchObject({ code: "GIT_SOURCE_STALE" });
  });

  test("rejects a symbolic revision that moves during collection", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.txt");
    await writeFile(path, "one\n", "utf8");
    await commitAll(repository, "initial");
    await writeFile(path, "two\n", "utf8");
    await commitAll(repository, "second");
    const io: LocalGitInputIo = {
      beforeSourceVerification: async () => {
        await writeFile(path, "three\n", "utf8");
        await commitAll(repository, "third");
      },
    };

    await expect(
      captureLocalGitInput({ repository, commit: "HEAD" }, io),
    ).rejects.toMatchObject({ code: "GIT_SOURCE_STALE" });
  });

  test("does not execute configured clean filters for worktree content", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.txt");
    await writeFile(
      join(repository, ".gitattributes"),
      "value.txt filter=evil\n",
    );
    await writeFile(path, "one\n", "utf8");
    await commitAll(repository, "initial");
    const marker = join(repository, ".git", "filter-ran");
    const filter = join(repository, ".git", "evil-filter.mjs");
    await writeFile(
      filter,
      `#!/usr/bin/env node\nimport { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(marker)}, "ran"); process.stdin.pipe(process.stdout);\n`,
      "utf8",
    );
    await chmod(filter, 0o700);
    await git(repository, ["config", "filter.evil.clean", filter]);
    await git(repository, ["config", "filter.evil.required", "true"]);
    await writeFile(path, "two\n", "utf8");

    const snapshot = await captureLocalGitInput({ repository, worktree: true });

    expect(snapshot.files.map((file) => file.path)).toContain("value.txt");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects filter configuration mutation during collection", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.txt");
    await writeFile(path, "one\n", "utf8");
    await commitAll(repository, "initial");
    await writeFile(path, "two\n", "utf8");
    const io: LocalGitInputIo = {
      beforeSourceVerification: async () => {
        await git(repository, ["config", "filter.late.required", "false"]);
      },
    };

    await expect(
      captureLocalGitInput({ repository, worktree: true }, io),
    ).rejects.toMatchObject({ code: "GIT_SOURCE_STALE" });
  });

  test("collects raw numstat and patch in one command per epoch", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.txt");
    await writeFile(path, "one\n", "utf8");
    await commitAll(repository, "initial");
    await writeFile(path, "two\n", "utf8");
    await git(repository, ["add", "--", "value.txt"]);
    const commands: string[][] = [];
    const io = {
      beforeDiffCommand: (args: readonly string[]) => {
        commands.push([...args]);
        return Promise.resolve();
      },
    } as LocalGitInputIo;

    await captureLocalGitInput({ repository, staged: true }, io);

    expect(commands).toHaveLength(2);
    expect(
      commands.every(
        (args) =>
          args.includes("--raw") &&
          args.includes("--numstat") &&
          args.includes("--patch"),
      ),
    ).toBe(true);
  });

  test("total deadline returns before a non-cancellable hook settles", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "value.txt"), "one\n", "utf8");
    await commitAll(repository, "initial");
    const io: LocalGitInputIo = {
      beforeSourceVerification: () =>
        new Promise((resolve) => setTimeout(resolve, 200)),
    };
    const startedAt = Date.now();

    await expect(
      captureLocalGitInput({ repository, staged: true, timeoutMs: 25 }, io),
    ).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
    expect(Date.now() - startedAt).toBeLessThan(150);
  });

  test("rejects a filter added after enumeration but before diff spawn", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.txt");
    await writeFile(
      join(repository, ".gitattributes"),
      "value.txt filter=late\n",
    );
    await writeFile(path, "one\n", "utf8");
    await commitAll(repository, "initial");
    await writeFile(path, "two\n", "utf8");
    const marker = join(repository, ".git", "late-filter-ran");
    const filter = join(repository, ".git", "late-filter.mjs");
    await writeFile(
      filter,
      `#!/usr/bin/env node\nimport { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(marker)}, "ran"); process.stdin.pipe(process.stdout);\n`,
      "utf8",
    );
    await chmod(filter, 0o700);
    let injected = false;
    const io = {
      afterFilterVerificationBeforeSpawn: async () => {
        if (injected) return;
        injected = true;
        await git(repository, ["config", "filter.late.clean", filter]);
      },
    } satisfies LocalGitInputIo;

    await expect(
      captureLocalGitInput({ repository, worktree: true }, io),
    ).rejects.toMatchObject({ code: "GIT_UNSAFE_CONFIGURATION" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
