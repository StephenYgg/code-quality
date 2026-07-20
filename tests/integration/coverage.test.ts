import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const executeFile = promisify(execFile);
const repository = fileURLToPath(new URL("../..", import.meta.url));
const provider = join(repository, "scripts", "vitest-coverage-provider.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("offline Vitest coverage", () => {
  test("reports production modules and runtime functions", async () => {
    const output = await mkdtemp(join(tmpdir(), "cq-coverage-"));
    temporaryDirectories.push(output);
    const sentinel = join(output, "owned-by-user.txt");
    await writeFile(sentinel, "keep", "utf8");

    await executeFile(
      "corepack",
      [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "tests/fixtures/coverage/runtime-covered.test.ts",
        "--maxWorkers=1",
        "--coverage",
        "--coverage.provider=custom",
        `--coverage.customProviderModule=${provider}`,
        `--coverage.reportsDirectory=${output}`,
      ],
      { cwd: repository, maxBuffer: 1024 * 1024 },
    );

    const report = JSON.parse(
      await readFile(join(output, "coverage-summary.json"), "utf8"),
    ) as {
      readonly schemaVersion: string;
      readonly files: readonly {
        readonly path: string;
        readonly functions: {
          readonly covered: number;
          readonly total: number;
        };
      }[];
      readonly totals: {
        readonly modules: { readonly covered: number; readonly total: number };
        readonly functions: {
          readonly covered: number;
          readonly total: number;
        };
      };
    };

    expect(report.schemaVersion).toBe("1");
    expect(report.files.map((file) => file.path)).toContain(
      "src/benchmark/evaluate.ts",
    );
    expect(report.files.map((file) => file.path)).not.toContain(
      "src/core/policy-types.ts",
    );
    expect(report.totals.modules.covered).toBeGreaterThan(0);
    expect(report.totals.modules.total).toBeGreaterThanOrEqual(
      report.totals.modules.covered,
    );
    expect(report.totals.functions.total).toBeGreaterThan(0);
    expect(report.totals.functions.covered).toBeGreaterThan(0);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
  });
});
