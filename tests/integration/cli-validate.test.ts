import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runCli, type CliIo } from "../../src/cli.js";

const temporaryDirectories: string[] = [];

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "cq-cli-"));
  temporaryDirectories.push(repository);
  return repository;
}

async function createFile(
  repository: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const absolutePath = join(repository, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function captureIo(): {
  readonly io: CliIo;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("cq validate", () => {
  test("returns exit 0 and PASS for a compliant repository", async () => {
    const repository = await createRepository();
    await createFile(repository, "AGENTS.md", "# Shared rules\n");
    await createFile(
      repository,
      "CLAUDE.md",
      "# Claude\n\nRead the sibling `AGENTS.md` in full and comply with it.\n",
    );
    const capture = captureIo();

    const exitCode = await runCli(["validate", repository], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("")).toContain("Gate: PASS");
    expect(capture.stderr).toEqual([]);
  });

  test("returns exit 0 and WARN for an advisory policy violation", async () => {
    const repository = await createRepository();
    await createFile(repository, "CLAUDE.md", "# Claude only\n");
    const capture = captureIo();

    const exitCode = await runCli(["validate", repository], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("")).toContain("Gate: WARN");
    expect(capture.stdout.join("")).toContain("ORPHAN_PEER_SCOPE");
  });

  test("emits parseable JSON when requested", async () => {
    const repository = await createRepository();
    await createFile(repository, "CLAUDE.md", "# Claude only\n");
    const capture = captureIo();

    const exitCode = await runCli(
      ["validate", repository, "--format", "json"],
      capture.io,
    );
    const report = JSON.parse(capture.stdout.join("")) as {
      gate: string;
      ruleId: string;
    };

    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ gate: "WARN", ruleId: "CQ-AGENT-001" });
    expect(capture.stderr).toEqual([]);
  });

  test("returns exit 2 for a missing repository without exposing a stack", async () => {
    const capture = captureIo();

    const exitCode = await runCli(
      ["validate", "/path/that/does/not/exist"],
      capture.io,
    );

    expect(exitCode).toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toContain(
      "Repository path must be a readable directory",
    );
    expect(capture.stderr.join("")).not.toContain(" at ");
  });

  test("returns exit 3 when validation is incomplete", async () => {
    const repository = await createRepository();
    await createFile(repository, "AGENTS.md", "# Shared rules\n");
    await symlink("missing.md", join(repository, "CLAUDE.md"));
    const capture = captureIo();

    const exitCode = await runCli(["validate", repository], capture.io);

    expect(exitCode).toBe(3);
    expect(capture.stdout.join("")).toContain("Gate: INCOMPLETE");
  });

  test("bounds and escapes an invalid-path error", async () => {
    const capture = captureIo();
    const unsafePath = `/missing/\u001b[31m${"x".repeat(10_000)}`;

    const exitCode = await runCli(["validate", unsafePath], capture.io);
    const output = capture.stderr.join("");

    expect(exitCode).toBe(2);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(2_200);
    expect(output).not.toContain("\u001b");
    expect(output).toContain("\\u001b[31m");
  });

  test("shows help without performing validation", async () => {
    const capture = captureIo();

    const exitCode = await runCli(["--help"], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("")).toContain("Usage: cq");
    expect(capture.stdout.join("")).not.toContain("Gate:");
    expect(capture.stderr).toEqual([]);
  });

  test("shows help without scanning when no command is supplied", async () => {
    const capture = captureIo();

    const exitCode = await runCli([], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("")).toContain("Usage: cq");
    expect(capture.stdout.join("")).not.toContain("Gate:");
    expect(capture.stderr).toEqual([]);
  });
});
