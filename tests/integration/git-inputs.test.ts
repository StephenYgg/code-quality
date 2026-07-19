import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  captureLocalGitInput,
  GitInputError,
  type LocalGitInputIo,
} from "../../src/git/inputs.js";

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
    expect(first.files.map((file) => file.path)).toEqual(trackedPaths);
    expect(first.exclusions).toContainEqual({
      path: untracked,
      reason: "untracked",
    });
    expect(first.incomplete).toBe(true);
    expect(first.contentHash).toBe(second.contentHash);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.files)).toBe(true);
    expect(Object.isFrozen(first.files[0])).toBe(true);
    expect(Reflect.set(first.files[0] ?? {}, "path", "mutated")).toBe(false);
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
