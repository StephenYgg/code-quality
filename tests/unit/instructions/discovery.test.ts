import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  captureDirectoryIdentity,
  discoverInstructionScopes,
  verifyDirectoryUnchanged,
} from "../../../src/instructions/discovery.js";

const temporaryDirectories: string[] = [];

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "cq-discovery-"));
  temporaryDirectories.push(repository);
  return repository;
}

async function createFile(
  repository: string,
  relativePath: string,
): Promise<void> {
  const absolutePath = join(repository, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, "# Instructions\n", "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("discoverInstructionScopes", () => {
  test("detects a directory rename-symlink-restore ABA sequence", async () => {
    const repository = await createRepository();
    const directory = join(repository, "nested");
    const backup = join(repository, "backup");
    const external = join(repository, "external");
    await mkdir(directory);
    await mkdir(external);
    const canonicalRepository = await realpath(repository);
    const canonicalDirectory = join(canonicalRepository, "nested");
    const identity = await captureDirectoryIdentity(
      canonicalRepository,
      canonicalDirectory,
    );
    await rename(directory, backup);
    await symlink(external, directory);
    await unlink(directory);
    await rename(backup, directory);

    await expect(
      verifyDirectoryUnchanged(
        canonicalRepository,
        canonicalDirectory,
        identity,
      ),
    ).rejects.toThrow("Directory changed");
  });

  test("groups canonical and peer files by repository-relative directory", async () => {
    const repository = await createRepository();
    await createFile(repository, "AGENTS.md");
    await createFile(repository, "CLAUDE.md");
    await createFile(repository, "packages/api/AGENTS.md");
    await createFile(repository, "packages/api/GEMINI.md");

    const result = await discoverInstructionScopes(repository);

    expect(result.diagnostics).toEqual([]);
    expect(result.scopes).toHaveLength(2);
    expect(result.scopes.map((scope) => scope.directory)).toEqual([
      ".",
      "packages/api",
    ]);
    expect(result.scopes[0]?.canonical?.relativePath).toBe("AGENTS.md");
    expect(result.scopes[0]?.peers.map((file) => file.relativePath)).toEqual([
      "CLAUDE.md",
    ]);
    expect(result.scopes[1]?.canonical?.relativePath).toBe(
      "packages/api/AGENTS.md",
    );
    expect(result.scopes[1]?.peers.map((file) => file.relativePath)).toEqual([
      "packages/api/GEMINI.md",
    ]);
  });

  test("reports a peer-only directory as an orphan scope", async () => {
    const repository = await createRepository();
    await createFile(repository, "nested/CLAUDE.md");

    const result = await discoverInstructionScopes(repository);

    expect(result.scopes).toHaveLength(1);
    expect(result.scopes[0]?.directory).toBe("nested");
    expect(result.scopes[0]?.canonical).toBeUndefined();
    expect(result.scopes[0]?.peers[0]?.relativePath).toBe("nested/CLAUDE.md");
  });

  test("does not descend into directory symlinks or generated directories", async () => {
    const repository = await createRepository();
    const externalDirectory = await createRepository();
    await createFile(repository, "AGENTS.md");
    await createFile(repository, "node_modules/example/CLAUDE.md");
    await createFile(repository, "dist/GEMINI.md");
    await createFile(externalDirectory, "CLAUDE.md");
    await symlink(externalDirectory, join(repository, "linked"));

    const result = await discoverInstructionScopes(repository);

    expect(result.scopes).toHaveLength(1);
    expect(result.scopes[0]?.directory).toBe(".");
    expect(result.scopes[0]?.peers).toEqual([]);
  });

  test("discovers a safe configured peer basename", async () => {
    const repository = await createRepository();
    await createFile(repository, "AGENTS.md");
    await createFile(repository, "QWEN.md");

    const result = await discoverInstructionScopes(repository, {
      peerFileNames: ["QWEN.md"],
    });

    expect(result.scopes[0]?.peers.map((file) => file.name)).toEqual([
      "QWEN.md",
    ]);
  });

  test("rejects a configured peer path instead of accepting a basename", async () => {
    const repository = await createRepository();

    await expect(
      discoverInstructionScopes(repository, {
        peerFileNames: ["../CLAUDE.md"],
      }),
    ).rejects.toThrow("Peer instruction filename must be a Markdown basename");
  });

  test("returns an incomplete diagnostic when the directory limit is exceeded", async () => {
    const repository = await createRepository();
    await createFile(repository, "AGENTS.md");
    await createFile(repository, "nested/CLAUDE.md");

    const result = await discoverInstructionScopes(repository, {
      maxDirectories: 1,
    });

    expect(result.scopes.map((scope) => scope.directory)).toEqual(["."]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "SCAN_LIMIT_EXCEEDED",
        path: "nested",
      }),
    ]);
  });

  test("applies directory limits after deterministic directory-entry ordering", async () => {
    const repository = await createRepository();
    await createFile(repository, "zeta/AGENTS.md");
    await createFile(repository, "alpha/AGENTS.md");

    const result = await discoverInstructionScopes(repository, {
      maxDirectories: 2,
    });

    expect(result.scopes.map((scope) => scope.directory)).toEqual(["alpha"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SCAN_LIMIT_EXCEEDED",
        path: "zeta",
      }),
    );
  });

  test("retains the globally earliest directories across nesting levels", async () => {
    const repository = await createRepository();
    await createFile(repository, "AGENTS.md");
    await createFile(repository, "z/AGENTS.md");
    await createFile(repository, "a/AGENTS.md");
    await createFile(repository, "a/aa/AGENTS.md");

    const result = await discoverInstructionScopes(repository, {
      maxDirectories: 3,
    });

    expect(result.scopes.map((scope) => scope.directory)).toEqual([
      ".",
      "a",
      "a/aa",
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SCAN_LIMIT_EXCEEDED",
        path: "z",
      }),
    );
  });

  test("rejects a directory limit above the non-removable hard maximum", async () => {
    const repository = await createRepository();

    await expect(
      discoverInstructionScopes(repository, {
        maxDirectories: 100_001,
      }),
    ).rejects.toThrow("Directory scan limit cannot exceed 100000");
  });

  test("stops collecting instruction files at their configured limit", async () => {
    const repository = await createRepository();
    await createFile(repository, "AGENTS.md");
    await createFile(repository, "CLAUDE.md");

    const result = await discoverInstructionScopes(repository, {
      maxInstructionFiles: 1,
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "SCAN_LIMIT_EXCEEDED" }),
    );
    expect(result.scopes[0]?.canonical?.relativePath).toBe("AGENTS.md");
    expect(result.scopes[0]?.peers).toEqual([]);
  });

  test("applies instruction limits after deterministic directory-entry ordering", async () => {
    const repository = await createRepository();
    await createFile(repository, "ZETA.md");
    await createFile(repository, "ALPHA.md");
    await createFile(repository, "AGENTS.md");

    const result = await discoverInstructionScopes(repository, {
      peerFileNames: ["ZETA.md", "ALPHA.md"],
      maxInstructionFiles: 1,
    });

    expect(result.scopes).toHaveLength(1);
    expect(result.scopes[0]?.canonical?.relativePath).toBe("AGENTS.md");
    expect(result.scopes[0]?.peers).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SCAN_LIMIT_EXCEEDED",
        path: "ALPHA.md",
      }),
    );
  });

  test("retains the globally earliest instruction file across nesting levels", async () => {
    const repository = await createRepository();
    await createFile(repository, "a/GEMINI.md");
    await createFile(repository, "a/A/AGENTS.md");

    const result = await discoverInstructionScopes(repository, {
      maxInstructionFiles: 1,
    });

    expect(result.scopes).toHaveLength(1);
    expect(result.scopes[0]?.directory).toBe("a/A");
    expect(result.scopes[0]?.canonical?.relativePath).toBe("a/A/AGENTS.md");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SCAN_LIMIT_EXCEEDED",
        path: "a/GEMINI.md",
      }),
    );
  });

  test("stops streaming when the total directory-entry limit is exceeded", async () => {
    const repository = await createRepository();
    await createFile(repository, "one.txt");
    await createFile(repository, "two.txt");

    const result = await discoverInstructionScopes(repository, {
      maxEntries: 1,
    });

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SCAN_LIMIT_EXCEEDED",
        path: ".",
      }),
    );
  });

  test("does not expose order-dependent partial scopes after the entry limit", async () => {
    const repository = await createRepository();
    await createFile(repository, "ZETA.md");
    await createFile(repository, "AGENTS.md");

    const result = await discoverInstructionScopes(repository, {
      peerFileNames: ["ZETA.md"],
      maxEntries: 1,
    });

    expect(result.scopes).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "SCAN_LIMIT_EXCEEDED", path: "." }),
    );
  });

  test("bounds discovery diagnostics including the truncation sentinel", async () => {
    const repository = await createRepository();
    await createFile(repository, "AGENTS.md");
    await createFile(repository, "CLAUDE.md");
    await createFile(repository, "nested/AGENTS.md");

    const result = await discoverInstructionScopes(repository, {
      maxDirectories: 1,
      maxInstructionFiles: 1,
      maxDiagnostics: 1,
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({ code: "DIAGNOSTIC_LIMIT_EXCEEDED" }),
    );
  });
});
