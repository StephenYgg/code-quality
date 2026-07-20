import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { materializeForgeChange } from "../../src/forges/materialize.js";
import { parseForgeUrl } from "../../src/forges/url.js";
import { runReviewCommand } from "../../src/commands/review.js";
import type {
  ProviderReviewResponse,
  ReviewProvider,
} from "../../src/providers/provider.js";
import { bindBasePolicy } from "../../src/review/base-policy.js";
import { collectReviewContext } from "../../src/review/context.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

class CountingProvider implements ReviewProvider {
  capabilitiesCalls = 0;
  requests = 0;

  capabilities() {
    this.capabilitiesCalls += 1;
    return {
      kind: "codex_cli" as const,
      transport: "process" as const,
      structuredOutput: "prompt_json" as const,
      isolation: "no_tools" as const,
      usage: "unavailable" as const,
      finishReason: "derived" as const,
      requestId: "execution_id" as const,
      cancellation: true as const,
    };
  }

  validateConfiguration() {
    return Promise.resolve([]);
  }

  review(): Promise<ProviderReviewResponse> {
    this.requests += 1;
    return Promise.resolve({
      content: { candidates: [] },
      usage: null,
      finishReason: "stop",
      rawFinishReason: null,
      providerRequestId: "counting",
      truncated: false,
      attemptsUsed: 1,
    });
  }

  redactDiagnostic(value: unknown): string {
    return String(value);
  }
}

function githubTransport(baseSha: string, headSha: string) {
  return {
    fetch(input: string | URL | Request) {
      const href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            href.includes("/files?")
              ? [
                  {
                    filename: "app.ts",
                    status: "modified",
                    patch: "@@ -1 +1 @@\n-old\n+new\n",
                  },
                ]
              : {
                  title: "local change",
                  body: "",
                  base: { sha: baseSha },
                  head: { sha: headSha },
                  changed_files: 1,
                },
          ),
          { status: 200 },
        ),
      );
    },
  };
}

async function directoryEntryCount(path: string): Promise<number> {
  try {
    return (await readdir(path)).length;
  } catch {
    return 0;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await executeFile("git", ["--no-pager", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "cq",
      GIT_AUTHOR_EMAIL: "cq@example.invalid",
      GIT_COMMITTER_NAME: "cq",
      GIT_COMMITTER_EMAIL: "cq@example.invalid",
    },
  });
  return result.stdout.trim();
}

describe("forge materialization and base-policy", () => {
  test("fails closed when the authoritative base policy is invalid", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-forge-policy-"));
    temporaryDirectories.push(repository);
    await mkdir(join(repository, ".code-quality"));
    await writeFile(
      join(repository, ".code-quality", "profile.yaml"),
      [
        'schemaVersion: "1"',
        "id: invalid-base",
        "version: 1",
        "rulePacks:",
        "  - missing:pack",
        "",
      ].join("\n"),
    );

    await expect(
      bindBasePolicy({
        baseWorktree: repository,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      }),
    ).rejects.toThrow(/base policy|rule pack|invalid/iu);
  });

  test("binds Provider and model from the base revision before review", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-forge-provider-"));
    temporaryDirectories.push(root);
    const source = join(root, "source");
    const cache = join(root, "cache");
    const state = join(root, "state");
    const configPath = join(root, "config.yaml");
    await mkdir(source);
    await git(source, ["init", "--quiet"]);
    await mkdir(join(source, ".code-quality"));
    await writeFile(
      join(source, ".code-quality", "profile.yaml"),
      [
        'schemaVersion: "1"',
        "id: base-profile",
        "version: 1",
        "rulePacks: [builtin:universal]",
        "provider:",
        "  name: base-provider",
        "  model: base-model",
        "qualityCommands:",
        "  - label: base-quality-check",
        `    argv: [${JSON.stringify(process.execPath)}, "--version"]`,
        "    timeoutMs: 1000",
        "    maxStdoutBytes: 4096",
        "    maxStderrBytes: 4096",
        "",
      ].join("\n"),
    );
    await writeFile(join(source, "app.ts"), "export const value = 'old';\n");
    await git(source, ["add", "--all", "--"]);
    await git(source, ["commit", "--quiet", "-m", "base"]);
    const baseSha = await git(source, ["rev-parse", "HEAD"]);
    await writeFile(
      join(source, ".code-quality", "profile.yaml"),
      [
        'schemaVersion: "1"',
        "id: untrusted-head-profile",
        "version: 99",
        "rulePacks: [builtin:universal]",
        "provider:",
        "  name: other-provider",
        "  model: other-model",
        "qualityCommands:",
        "  - label: untrusted-head-check",
        `    argv: [${JSON.stringify(process.execPath)}, "malicious.js"]`,
        "    timeoutMs: 1000",
        "    maxStdoutBytes: 4096",
        "    maxStderrBytes: 4096",
        "",
      ].join("\n"),
    );
    await writeFile(join(source, "app.ts"), "export const value = 'new';\n");
    await git(source, ["add", "--all", "--"]);
    await git(source, ["commit", "--quiet", "-m", "head"]);
    const headSha = await git(source, ["rev-parse", "HEAD"]);

    const barePath = join(cache, "bare", "github.com", "acme", "app.git");
    await mkdir(join(cache, "bare", "github.com", "acme"), {
      recursive: true,
    });
    await git(root, ["clone", "--quiet", "--bare", source, barePath]);
    const executable = fileURLToPath(
      new URL("../fixtures/providers/fake-cli.mjs", import.meta.url),
    );
    await writeFile(
      configPath,
      [
        'schemaVersion: "1"',
        "defaultProvider: other-provider",
        "providers:",
        "  - name: other-provider",
        "    kind: codex_cli",
        `    executable: ${executable}`,
        "    allowedModels: [other-model]",
        "    defaultModel: other-model",
        "  - name: base-provider",
        "    kind: codex_cli",
        `    executable: ${executable}`,
        "    allowedModels: [base-model]",
        "    defaultModel: base-model",
        "",
      ].join("\n"),
    );

    const previousCache = process.env.CQ_CACHE_DIR;
    const previousState = process.env.CQ_STATE_DIR;
    process.env.CQ_CACHE_DIR = cache;
    process.env.CQ_STATE_DIR = state;
    try {
      const preview = await runReviewCommand({
        forgeUrl: "https://github.com/acme/app/pull/1",
        configPath,
        forgeTransport: githubTransport(baseSha, headSha),
        runChecks: true,
        runChecksPreviewOnly: true,
      });
      expect(preview.exitCode).toBe(0);
      expect(preview.output).toContain("base-quality-check");
      expect(preview.output).not.toContain("untrusted-head-check");

      const result = await runReviewCommand({
        forgeUrl: "https://github.com/acme/app/pull/1",
        configPath,
        forgeTransport: githubTransport(baseSha, headSha),
        disableSingleFlight: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(
        "Provider: base-provider (codex_cli) model=base-model",
      );
      expect(result.output).not.toContain("Provider: other-provider");
      expect(await directoryEntryCount(join(cache, "worktrees"))).toBe(0);
    } finally {
      if (previousCache === undefined) delete process.env.CQ_CACHE_DIR;
      else process.env.CQ_CACHE_DIR = previousCache;
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
    }
  }, 20_000);

  test("does not resolve or call a Provider when materialization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-forge-failure-"));
    temporaryDirectories.push(root);
    const cache = join(root, "cache");
    const barePath = join(cache, "bare", "github.com", "acme", "app.git");
    await mkdir(barePath, { recursive: true });
    await git(barePath, ["init", "--quiet", "--bare"]);
    await git(barePath, ["remote", "add", "origin", join(root, "missing")]);
    const provider = new CountingProvider();
    const previousCache = process.env.CQ_CACHE_DIR;
    process.env.CQ_CACHE_DIR = cache;
    try {
      const result = await runReviewCommand({
        forgeUrl: "https://github.com/acme/app/pull/1",
        provider,
        forgeTransport: githubTransport("a".repeat(40), "b".repeat(40)),
      });

      expect(result.exitCode).toBe(3);
      expect(result.output).toMatch(/materializ|INCOMPLETE/iu);
      expect(provider.capabilitiesCalls).toBe(0);
      expect(provider.requests).toBe(0);
    } finally {
      if (previousCache === undefined) delete process.env.CQ_CACHE_DIR;
      else process.env.CQ_CACHE_DIR = previousCache;
    }
  });

  test("materializes a fork head from its independently trusted clone URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-forge-fork-"));
    temporaryDirectories.push(root);
    const baseSource = join(root, "base-source");
    const headSource = join(root, "head-source");
    const cache = join(root, "cache");
    await mkdir(baseSource);
    await git(baseSource, ["init", "--quiet"]);
    await writeFile(join(baseSource, "app.ts"), "export const value = 1;\n");
    await git(baseSource, ["add", "--all", "--"]);
    await git(baseSource, ["commit", "--quiet", "-m", "base"]);
    const baseSha = await git(baseSource, ["rev-parse", "HEAD"]);
    await git(root, ["clone", "--quiet", baseSource, headSource]);
    await writeFile(join(headSource, "app.ts"), "export const value = 2;\n");
    await git(headSource, ["add", "--all", "--"]);
    await git(headSource, ["commit", "--quiet", "-m", "fork head"]);
    const headSha = await git(headSource, ["rev-parse", "HEAD"]);

    const checkout = await materializeForgeChange({
      url: parseForgeUrl("https://github.com/acme/app/pull/1"),
      baseSha,
      headSha,
      cloneUrl: pathToFileURL(baseSource).href,
      headCloneUrl: pathToFileURL(headSource).href,
      env: { CQ_CACHE_DIR: cache, CQ_STATE_DIR: join(root, "state") },
    });
    try {
      expect(checkout.reviewInput.contentByPath.get("app.ts")?.toString()).toBe(
        "export const value = 2;\n",
      );
    } finally {
      await checkout.dispose();
    }
  });

  test("serializes concurrent mirror mutation while keeping worktrees independent", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-forge-concurrent-"));
    temporaryDirectories.push(root);
    const source = join(root, "source");
    const cache = join(root, "cache");
    const state = join(root, "state");
    await mkdir(source);
    await git(source, ["init", "--quiet"]);
    await writeFile(join(source, "app.ts"), "export const value = 1;\n");
    await git(source, ["add", "--all", "--"]);
    await git(source, ["commit", "--quiet", "-m", "base"]);
    const baseSha = await git(source, ["rev-parse", "HEAD"]);
    await writeFile(join(source, "app.ts"), "export const value = 2;\n");
    await git(source, ["add", "--all", "--"]);
    await git(source, ["commit", "--quiet", "-m", "head"]);
    const headSha = await git(source, ["rev-parse", "HEAD"]);
    const request = {
      url: parseForgeUrl("https://github.com/acme/app/pull/1"),
      baseSha,
      headSha,
      cloneUrl: pathToFileURL(source).href,
      env: { CQ_CACHE_DIR: cache, CQ_STATE_DIR: state },
    };

    const checkouts = await Promise.all(
      Array.from({ length: 8 }, () => materializeForgeChange(request)),
    );
    try {
      expect(new Set(checkouts.map((item) => item.headWorktree)).size).toBe(8);
      expect(
        checkouts.every(
          (item) =>
            item.reviewInput.contentByPath.get("app.ts")?.toString() ===
            "export const value = 2;\n",
        ),
      ).toBe(true);
    } finally {
      await Promise.all(checkouts.map((item) => item.dispose()));
    }
    expect(await directoryEntryCount(join(cache, "worktrees"))).toBe(0);
  }, 20_000);

  test("reuses acquired commits without refreshing the remote for every request", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-forge-cache-reuse-"));
    temporaryDirectories.push(root);
    const source = join(root, "source");
    const cache = join(root, "cache");
    const state = join(root, "state");
    await mkdir(source);
    await git(source, ["init", "--quiet"]);
    await writeFile(join(source, "app.ts"), "export const value = 1;\n");
    await git(source, ["add", "--all", "--"]);
    await git(source, ["commit", "--quiet", "-m", "base"]);
    const baseSha = await git(source, ["rev-parse", "HEAD"]);
    await writeFile(join(source, "app.ts"), "export const value = 2;\n");
    await git(source, ["add", "--all", "--"]);
    await git(source, ["commit", "--quiet", "-m", "head"]);
    const headSha = await git(source, ["rev-parse", "HEAD"]);
    const request = {
      url: parseForgeUrl("https://github.com/acme/app/pull/1"),
      baseSha,
      headSha,
      cloneUrl: pathToFileURL(source).href,
      env: { CQ_CACHE_DIR: cache, CQ_STATE_DIR: state },
    };

    const first = await materializeForgeChange(request);
    await first.dispose();
    await rm(source, { recursive: true });

    const second = await materializeForgeChange(request);
    try {
      expect(second.reviewInput.contentByPath.get("app.ts")?.toString()).toBe(
        "export const value = 2;\n",
      );
    } finally {
      await second.dispose();
    }
  });

  test("materializes bare cache + disposable worktrees and binds base policy only", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-forge-mat-"));
    temporaryDirectories.push(root);
    const source = join(root, "source");
    const cache = join(root, "cache");
    await mkdir(source);
    await git(source, ["init", "--quiet"]);
    await mkdir(join(source, ".code-quality"), { recursive: true });
    await writeFile(
      join(source, ".code-quality", "profile.yaml"),
      [
        'schemaVersion: "1"',
        "id: base-profile",
        "version: 1",
        "rulePacks:",
        "  - builtin:universal",
        "dataClassification: internal",
        "qualityCommands:",
        "  - label: base-check",
        "    argv: [node, --version]",
        "    timeoutMs: 1000",
        "    maxStdoutBytes: 4096",
        "    maxStderrBytes: 4096",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(source, "app.ts"), "export const n = 1;\n", "utf8");
    await git(source, ["add", "--all", "--"]);
    await git(source, ["commit", "--quiet", "-m", "base"]);
    const baseSha = await git(source, ["rev-parse", "HEAD"]);

    await writeFile(join(source, "app.ts"), "export const n = 2;\n", "utf8");
    await writeFile(
      join(source, ".code-quality", "profile.yaml"),
      [
        'schemaVersion: "1"',
        "id: head-profile-should-not-activate",
        "version: 99",
        "rulePacks:",
        "  - builtin:universal",
        "dataClassification: confidential",
        "qualityCommands:",
        "  - label: untrusted-head-check",
        "    argv: [node, malicious.js]",
        "    timeoutMs: 1000",
        "    maxStdoutBytes: 4096",
        "    maxStderrBytes: 4096",
        "",
      ].join("\n"),
      "utf8",
    );
    await git(source, ["add", "--all", "--"]);
    await git(source, ["commit", "--quiet", "-m", "head"]);
    const headSha = await git(source, ["rev-parse", "HEAD"]);

    const url = parseForgeUrl("https://github.com/acme/demo/pull/1");
    const cloneUrl = pathToFileURL(source).href;
    const materialized = await materializeForgeChange({
      url,
      baseSha,
      headSha,
      cloneUrl,
      env: { CQ_CACHE_DIR: cache },
    });

    try {
      expect(materialized.baseSha).toBe(baseSha);
      expect(materialized.headSha).toBe(headSha);
      expect(materialized.snapshot.files.map((file) => file.path)).toContain(
        "app.ts",
      );
      expect(materialized.snapshot.inputKind).toBe("github_pr");
      const context = await collectReviewContext(
        materialized.reviewInput.snapshot,
        { contentByPath: materialized.reviewInput.contentByPath },
      );
      expect(context.incomplete).toBe(false);
      expect(context.files).toContainEqual(
        expect.objectContaining({
          path: "app.ts",
          content: "export const n = 2;\n",
        }),
      );

      const baseProfile = await readFile(
        join(materialized.baseWorktree, ".code-quality", "profile.yaml"),
        "utf8",
      );
      const headProfile = await readFile(
        join(materialized.headWorktree, ".code-quality", "profile.yaml"),
        "utf8",
      );
      expect(baseProfile).toContain("base-profile");
      expect(headProfile).toContain("head-profile-should-not-activate");

      const binding = await bindBasePolicy({
        baseWorktree: materialized.baseWorktree,
        headWorktree: materialized.headWorktree,
        baseSha,
        headSha,
      });
      expect(binding.baseSha).toBe(baseSha);
      expect(binding.headPolicyPathsIgnored).toContain(
        ".code-quality/profile.yaml",
      );
      expect(binding.dataClassification).toBe("internal");
      expect(binding.qualityCommands).toEqual([
        {
          label: "base-check",
          argv: ["node", "--version"],
          timeoutMs: 1000,
          maxStdoutBytes: 4096,
          maxStderrBytes: 4096,
        },
      ]);
      expect(binding.diagnostics.join("\n")).toMatch(/Ignoring head revision/i);
    } finally {
      await materialized.dispose();
    }
  });
});
