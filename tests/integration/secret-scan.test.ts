import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const executeFile = promisify(execFile);
const scanner = fileURLToPath(
  new URL("../../scripts/check-secrets.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];
const syntheticSecret = "api" + "_key=" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "cq-secret-scan-"));
  temporaryDirectories.push(repository);
  await executeFile("git", ["init", "--quiet"], { cwd: repository });
  return repository;
}

async function runScanner(
  repository: string,
  environment?: NodeJS.ProcessEnv,
): Promise<{
  readonly exitCode: number;
  readonly output: string;
}> {
  try {
    const result = await executeFile(process.execPath, [scanner], {
      cwd: repository,
      maxBuffer: 1024 * 1024,
      ...(environment === undefined ? {} : { env: environment }),
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

describe("release secret scan", () => {
  test("scans synthetic secrets under tests and templates", async () => {
    const repository = await createRepository();
    await Promise.all([
      mkdir(join(repository, "tests"), { recursive: true }),
      mkdir(join(repository, "templates"), { recursive: true }),
    ]);
    await writeFile(
      join(repository, "tests", "synthetic.txt"),
      syntheticSecret,
      "utf8",
    );

    const result = await runScanner(repository);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("tests/synthetic.txt");
  });

  test("fails when a release file exceeds the scan byte limit", async () => {
    const repository = await createRepository();
    await writeFile(
      join(repository, "oversized.txt"),
      "x".repeat(1024 * 1024 + 1),
      "utf8",
    );

    const result = await runScanner(repository);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("scan byte limit");
  });

  test("fails closed when Git path enumeration is truncated", async () => {
    const repository = await createRepository();
    const executableDirectory = join(repository, "bin");
    await mkdir(executableDirectory);
    const fakeGit = join(executableDirectory, "git");
    await writeFile(
      fakeGit,
      [
        "#!/usr/bin/env node",
        'process.stdout.write("x".repeat(8 * 1024 * 1024 + 1));',
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeGit, 0o755);

    const result = await runScanner(repository, {
      ...process.env,
      PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("enumeration failed or was truncated");
  });

  test("honors only reviewed, unexpired, exact-match allowlist entries", async () => {
    const repository = await createRepository();
    await mkdir(join(repository, "tests"), { recursive: true });
    await mkdir(join(repository, "config"), { recursive: true });
    await writeFile(
      join(repository, "tests", "synthetic.txt"),
      syntheticSecret,
      "utf8",
    );
    const allowlistPath = join(
      repository,
      "config",
      "secret-scan-allowlist.json",
    );
    const entry = {
      path: "tests/synthetic.txt",
      patternId: "credential-assignment",
      matchSha256: createHash("sha256").update(syntheticSecret).digest("hex"),
      owner: "code-quality",
      reason: "Synthetic scanner regression fixture.",
    };
    await writeFile(
      allowlistPath,
      JSON.stringify({
        schemaVersion: "1",
        entries: [{ ...entry, expiresAt: "2099-01-01T00:00:00.000Z" }],
      }),
      "utf8",
    );

    expect(await runScanner(repository)).toMatchObject({ exitCode: 0 });

    await writeFile(
      allowlistPath,
      JSON.stringify({
        schemaVersion: "1",
        entries: [{ ...entry, expiresAt: "2000-01-01T00:00:00.000Z" }],
      }),
      "utf8",
    );
    const expired = await runScanner(repository);
    expect(expired.exitCode).toBe(1);
    expect(expired.output).toContain("expired allowlist");
  });
});
