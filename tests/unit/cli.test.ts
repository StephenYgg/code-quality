import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, test } from "vitest";

import { isExecutedModule } from "../../src/cli.js";

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
