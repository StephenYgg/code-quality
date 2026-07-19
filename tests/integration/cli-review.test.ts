import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { runCli } from "../../src/cli.js";
import { runReviewCommand } from "../../src/commands/review.js";
import type {
  ProviderDiagnostic,
  ProviderReviewRequest,
  ProviderReviewResponse,
  ReviewProvider,
} from "../../src/providers/provider.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

class FakeProvider implements ReviewProvider {
  capabilities() {
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
  validateConfiguration(): Promise<readonly ProviderDiagnostic[]> {
    return Promise.resolve([]);
  }
  review(request: ProviderReviewRequest): Promise<ProviderReviewResponse> {
    void request;
    return Promise.resolve({
      content: { candidates: [] },
      usage: null,
      finishReason: "stop",
      rawFinishReason: null,
      providerRequestId: "fake",
      truncated: false,
      attemptsUsed: 1,
    });
  }
  redactDiagnostic(value: unknown): string {
    return String(value);
  }
}

async function git(repository: string, args: readonly string[]): Promise<void> {
  await executeFile(
    "git",
    [
      "--no-pager",
      "-c",
      "user.name=Code Quality Test",
      "-c",
      "user.email=code-quality@example.invalid",
      ...args,
    ],
    {
      cwd: repository,
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        PATH: process.env.PATH ?? "",
      },
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("review CLI surface", () => {
  test("repository preflight does not require a provider", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-cli-"));
    temporaryDirectories.push(repository);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const previous = process.cwd();
    process.chdir(repository);
    try {
      const result = await runReviewCommand({
        repository: ".",
        preflight: true,
        format: "json",
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("confirmationHash");
    } finally {
      process.chdir(previous);
    }
  });

  test("staged review stores a run with a fake provider", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-cli-"));
    const state = await mkdtemp(join(tmpdir(), "cq-state-"));
    temporaryDirectories.push(repository, state);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.ts"), "export const a = 2;\n");
    await git(repository, ["add", "--all", "--"]);

    const previous = process.cwd();
    const previousState = process.env.CQ_STATE_DIR;
    process.chdir(repository);
    process.env.CQ_STATE_DIR = state;
    try {
      const result = await runReviewCommand({
        staged: true,
        provider: new FakeProvider(),
        format: "terminal",
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Gate:");
    } finally {
      process.chdir(previous);
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
    }
  });

  test("cli help lists review command", async () => {
    const chunks: string[] = [];
    const exitCode = await runCli(["--help"], {
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
        },
      },
      stderr: { write() {} },
    });
    expect(exitCode).toBe(0);
    expect(chunks.join("")).toContain("review");
  });
});
