import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, test } from "vitest";

import { isExecutedModule, runCli } from "../../src/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

test("recognizes execution through a symlinked binary path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cq-entry-"));
  temporaryDirectories.push(directory);
  const target = join(directory, "cli.js");
  const executable = join(directory, "cq");
  await writeFile(target, "", "utf8");
  await symlink("cli.js", executable);

  expect(isExecutedModule(executable, pathToFileURL(target).href)).toBe(true);
  expect(
    isExecutedModule(resolve(directory, "other"), pathToFileURL(target).href),
  ).toBe(false);
});

test("providers validate exposes an explicit forge selector", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(["providers", "validate", "--help"], {
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
  });

  expect(exitCode).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout.join("")).toContain("--forge <forge>");
  expect(stdout.join("")).toContain("github or gitlab");
});

test("benchmark help is registered without running the corpus", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(["benchmark", "--help"], {
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
  });

  expect(exitCode).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout.join("")).toContain("--observations <path>");
});
