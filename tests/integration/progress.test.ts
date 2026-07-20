import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const executeFile = promisify(execFile);
const checker = fileURLToPath(
  new URL("../../scripts/check-progress.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function writeMatrix(statuses: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cq-progress-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "PROGRESS.md");
  const rows = statuses.map(
    (status, index) =>
      `| ${(index + 1).toString()} | Criterion ${(
        index + 1
      ).toString()} | ${status} | evidence |`,
  );
  await writeFile(
    path,
    [
      "| # | Criterion | Status | Evidence |",
      "| --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

async function runChecker(path: string) {
  try {
    const result = await executeFile(process.execPath, [checker, path], {
      maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const result = error as {
      readonly code?: number;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    return {
      exitCode: result.code ?? 1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  }
}

describe("acceptance progress checker", () => {
  test("generates the weighted percentage from exactly 19 criteria", async () => {
    const path = await writeMatrix([
      ...Array.from({ length: 18 }, () => "Complete"),
      "Partial",
    ]);

    const result = await runChecker(path);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("complete=18 partial=1 failed=0");
    expect(result.output).toContain("percentage=97.4");
  });

  test("fails on a missing criterion or unsupported status", async () => {
    const missing = await writeMatrix(
      Array.from({ length: 18 }, () => "Complete"),
    );
    const invalid = await writeMatrix([
      ...Array.from({ length: 18 }, () => "Complete"),
      "Strong",
    ]);

    await expect(runChecker(missing)).resolves.toMatchObject({ exitCode: 1 });
    await expect(runChecker(invalid)).resolves.toMatchObject({ exitCode: 1 });
  });
});
