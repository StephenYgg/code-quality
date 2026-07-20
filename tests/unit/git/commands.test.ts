import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runGitCommand } from "../../../src/git/commands.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("trusted Git command environment", () => {
  test("passes transient Git config in the environment without exposing it in argv", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-git-config-"));
    temporaryDirectories.push(repository);
    const executable = join(repository, "capture-git");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" > "$PWD/argv.txt"',
        'env > "$PWD/env.txt"',
        "",
      ].join("\n"),
    );
    await chmod(executable, 0o700);

    await runGitCommand({
      repository,
      executable,
      args: ["status"],
      gitConfig: [
        {
          key: "http.https://github.com/.extraHeader",
          value: "Authorization: Bearer secret-token",
        },
      ],
    });

    const [argv, env] = await Promise.all([
      readFile(join(repository, "argv.txt"), "utf8"),
      readFile(join(repository, "env.txt"), "utf8"),
    ]);
    expect(argv).not.toContain("secret-token");
    expect(env).toContain("GIT_CONFIG_COUNT=1");
    expect(env).toContain(
      "GIT_CONFIG_KEY_0=http.https://github.com/.extraHeader",
    );
    expect(env).toContain(
      "GIT_CONFIG_VALUE_0=Authorization: Bearer secret-token",
    );
  });

  test.each([
    ["config", "--get", "core.hooksPath"],
    ["rev-parse", "--git-path", "hooks"],
  ])("allows the exact read-only hooksPath query: %s", async (...args) => {
    const repository = await mkdtemp(join(tmpdir(), "cq-git-hooks-query-"));
    temporaryDirectories.push(repository);
    const executable = join(repository, "capture-git");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);

    await expect(
      runGitCommand({
        repository,
        executable,
        args,
        hooksPathQuery: true,
      }),
    ).resolves.toBeDefined();
  });

  test.each([
    ["config", "--global", "--get", "core.hooksPath"],
    ["config", "--get-regexp", "core.hooksPath"],
    ["rev-parse", "--git-path", "objects"],
    ["rev-parse", "--git-path", "hooks", "extra"],
  ])("rejects a non-whitelisted hooksPath query: %s", async (...args) => {
    const repository = await mkdtemp(join(tmpdir(), "cq-git-hooks-query-"));
    temporaryDirectories.push(repository);
    const executable = join(repository, "capture-git");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o700);

    await expect(
      runGitCommand({
        repository,
        executable,
        args,
        hooksPathQuery: true,
      }),
    ).rejects.toMatchObject({ code: "GIT_ARGUMENT_INVALID" });
  });
});
