import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  decodeGitUtf8,
  parseGitDiffEnvelope,
  SnapshotFormatError,
} from "../../../src/core/snapshots.js";
import { GitCommandError, runGitCommand } from "../../../src/git/commands.js";

const temporaryDirectories: string[] = [];

async function createExecutable(source: string): Promise<{
  readonly executable: string;
  readonly repository: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), "cq-git-command-"));
  temporaryDirectories.push(repository);
  const executable = join(repository, "fake-git.mjs");
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, "utf8");
  await chmod(executable, 0o700);
  return { executable, repository };
}

afterEach(async () => {
  delete process.env.CQ_TEST_SECRET;
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("runGitCommand", () => {
  test("does not resolve git from an empty or relative PATH entry", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-git-path-"));
    temporaryDirectories.push(repository);
    const marker = join(repository, "repo-git-ran");
    const executable = join(repository, "git");
    await writeFile(
      executable,
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf 'repo git'\n`,
      "utf8",
    );
    await chmod(executable, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${repository}:.:${originalPath ?? ""}`;

    try {
      const result = await runGitCommand({
        repository,
        args: ["--version"],
      });
      expect(result.stdout.toString("utf8")).toContain("git version");
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  test("passes arguments literally with a sanitized environment", async () => {
    const { executable, repository } = await createExecutable(
      `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), optionalLocks: process.env.GIT_OPTIONAL_LOCKS, secret: process.env.CQ_TEST_SECRET }));`,
    );
    process.env.CQ_TEST_SECRET = "must-not-leak";
    const literal = "$(touch should-not-exist)";

    const result = await runGitCommand({
      repository,
      executable,
      args: ["status", "--", literal],
    });
    const observed = JSON.parse(result.stdout.toString("utf8")) as {
      readonly argv: readonly string[];
      readonly optionalLocks?: string;
      readonly secret?: string;
    };

    expect(observed.argv).toContain(literal);
    expect(observed.argv).toContain("--no-pager");
    expect(observed.argv).toContain("core.fsmonitor=false");
    expect(observed.argv).toContain("credential.helper=");
    expect(observed.argv).toContain("diff.external=");
    expect(observed.optionalLocks).toBe("0");
    expect(observed.secret).toBeUndefined();
  });

  test("terminates output that exceeds the stdout hard cap", async () => {
    const { executable, repository } = await createExecutable(
      `process.stdout.write("x".repeat(4096)); setInterval(() => undefined, 1000);`,
    );

    await expect(
      runGitCommand({
        repository,
        executable,
        args: ["status"],
        maximumStdoutBytes: 32,
      }),
    ).rejects.toMatchObject({
      code: "GIT_STDOUT_LIMIT_EXCEEDED",
    } satisfies Partial<GitCommandError>);
  });

  test("terminates output that exceeds the stderr hard cap", async () => {
    const { executable, repository } = await createExecutable(
      `process.stderr.write("x".repeat(4096)); setInterval(() => undefined, 1000);`,
    );

    await expect(
      runGitCommand({
        repository,
        executable,
        args: ["status"],
        maximumStderrBytes: 32,
      }),
    ).rejects.toMatchObject({
      code: "GIT_STDERR_LIMIT_EXCEEDED",
    } satisfies Partial<GitCommandError>);
  });

  test("escapes control characters in bounded failure diagnostics", async () => {
    const { executable, repository } = await createExecutable(
      `process.stderr.write("\\u001b[31mfailed\\nnext"); process.exitCode = 7;`,
    );

    const rejection = runGitCommand({
      repository,
      executable,
      args: ["status"],
      maximumStderrBytes: 64,
    });

    await expect(rejection).rejects.toMatchObject({
      code: "GIT_COMMAND_FAILED",
      exitCode: 7,
    } satisfies Partial<GitCommandError>);
    await expect(rejection).rejects.not.toThrow(String.fromCharCode(27));
    await expect(rejection).rejects.not.toThrow("failed\nnext");
  });

  test("terminates a command after its timeout", async () => {
    const { executable, repository } = await createExecutable(
      `setInterval(() => undefined, 1000);`,
    );

    await expect(
      runGitCommand({
        repository,
        executable,
        args: ["status"],
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({
      code: "GIT_TIMEOUT",
    } satisfies Partial<GitCommandError>);
  });

  test("terminates a running command when its signal aborts", async () => {
    const { executable, repository } = await createExecutable(
      `setInterval(() => undefined, 1000);`,
    );
    const controller = new AbortController();
    const pending = runGitCommand({
      repository,
      executable,
      args: ["status"],
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "GIT_ABORTED",
    } satisfies Partial<GitCommandError>);
  });
});

describe("Git diff envelope parsing", () => {
  const raw = `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\x00value.txt\x00`;
  const patch = "\x00diff --git a/value.txt b/value.txt\n";

  test("rejects missing and duplicate numstat mappings", () => {
    expect(() =>
      parseGitDiffEnvelope(Buffer.from(`${raw}1\t1\tother.txt\x00${patch}`)),
    ).toThrow(SnapshotFormatError);
    expect(() =>
      parseGitDiffEnvelope(
        Buffer.from(`${raw}1\t1\tvalue.txt\x001\t1\tvalue.txt\x00${patch}`),
      ),
    ).toThrow(SnapshotFormatError);
  });

  test("rejects unknown status, partial binary stats, and rename mismatch", () => {
    const unknownRaw = raw.replace(" M\x00", " X\x00");
    expect(() =>
      parseGitDiffEnvelope(
        Buffer.from(`${unknownRaw}1\t1\tvalue.txt\x00${patch}`),
      ),
    ).toThrow(SnapshotFormatError);
    expect(() =>
      parseGitDiffEnvelope(Buffer.from(`${raw}-\t1\tvalue.txt\x00${patch}`)),
    ).toThrow(SnapshotFormatError);
    const renameRaw = `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} R100\x00old.txt\x00new.txt\x00`;
    expect(() =>
      parseGitDiffEnvelope(
        Buffer.from(`${renameRaw}0\t0\t\x00wrong.txt\x00new.txt\x00${patch}`),
      ),
    ).toThrow(SnapshotFormatError);
  });

  test("rejects malformed UTF-8 instead of replacing bytes", () => {
    expect(() => decodeGitUtf8(Buffer.from([0xc3, 0x28]))).toThrow(
      SnapshotFormatError,
    );
  });
});
