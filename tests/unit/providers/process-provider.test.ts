import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { ClaudeCliProvider } from "../../../src/providers/claude-cli.js";
import { CodexCliProvider } from "../../../src/providers/codex-cli.js";
import type { ProviderReviewRequest } from "../../../src/providers/provider.js";

const fakeCli = fileURLToPath(
  new URL("../../fixtures/providers/fake-cli.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

function baseRequest(
  overrides: Partial<ProviderReviewRequest> = {},
): ProviderReviewRequest {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    stageId: "behavior",
    model: "test-model",
    systemInstructions: "system",
    untrustedContext: [
      { role: "untrusted", label: "code", text: "const x = 1;" },
    ],
    outputSchema: { type: "object" },
    maxOutputTokens: 100,
    timeoutMs: 2_000,
    maxRequestBytes: 64 * 1024,
    maxResponseBytes: 64 * 1024,
    maxDiagnosticBytes: 16 * 1024,
    signal: new AbortController().signal,
    attemptBudget: { maxAttempts: 2, used: 0 },
    ...overrides,
  };
}

afterEach(async () => {
  delete process.env.CQ_FAKE_PROVIDER_MODE;
  delete process.env.CQ_TEST_TOKEN;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeHangingProbe(
  executable: string,
  pidPath: string,
): Promise<void> {
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      `const pidPath = ${JSON.stringify(pidPath)};`,
      "const args = process.argv.slice(2);",
      'if (args.includes("--version") || args.includes("--help")) {',
      '  writeFileSync(pidPath, `${process.pid}\\n`, "utf8");',
      '  process.on("SIGTERM", () => undefined);',
      "  setInterval(() => undefined, 60_000);",
      "} else { process.exit(2); }",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(executable, 0o700);
}

async function writeSelfDeletingProvider(executable: string): Promise<void> {
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      'import { statSync, unlinkSync, writeFileSync } from "node:fs";',
      `const configured = ${JSON.stringify(executable)};`,
      "const args = process.argv.slice(2);",
      'if (args.includes("--version")) { process.stdout.write("self-delete 1.0.0\\n"); process.exit(0); }',
      'if (args.includes("--help")) {',
      "  try { unlinkSync(configured); } catch {}",
      '  process.stdout.write("--sandbox\\n--ephemeral\\n--json\\n--output-last-message\\n--output-schema\\n--ignore-user-config\\n--ignore-rules\\n--skip-git-repo-check\\n--color\\n-c\\n-C\\n--model\\n");',
      "  process.exit(0);",
      "}",
      'const outputPath = args[args.indexOf("--output-last-message") + 1];',
      "const outputFileMode = (statSync(outputPath).mode & 0o777).toString(8);",
      'writeFileSync(outputPath, JSON.stringify({ summary: "snapshot", outputFileMode }), "utf8");',
      'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "snapshot-thread" })}\\n`);',
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(executable, 0o700);
}

async function writeFloodingOutputProvider(
  executable: string,
  evidencePath: string,
): Promise<void> {
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      'import { statSync, writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'if (args.includes("--version")) { process.stdout.write("flood 1.0.0\\n"); process.exit(0); }',
      'if (args.includes("--help")) {',
      '  process.stdout.write("--sandbox\\n--ephemeral\\n--json\\n--output-last-message\\n--output-schema\\n--ignore-user-config\\n--ignore-rules\\n--skip-git-repo-check\\n--color\\n-c\\n-C\\n--model\\n");',
      "  process.exit(0);",
      "}",
      'const outputPath = args[args.indexOf("--output-last-message") + 1];',
      "const metadata = statSync(outputPath);",
      `writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({ isFile: metadata.isFile(), isFIFO: metadata.isFIFO(), isSocket: metadata.isSocket() }), "utf8");`,
      "writeFileSync(outputPath, Buffer.alloc(8 * 1024 * 1024, 0x66));",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(executable, 0o700);
}

async function writeLeakedOutputFdProvider(
  executable: string,
  pidPath: string,
): Promise<void> {
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'if (args.includes("--version")) { process.stdout.write("fd-leak 1.0.0\\n"); process.exit(0); }',
      'if (args.includes("--help")) {',
      '  process.stdout.write("--sandbox\\n--ephemeral\\n--json\\n--output-last-message\\n--output-schema\\n--ignore-user-config\\n--ignore-rules\\n--skip-git-repo-check\\n--color\\n-c\\n-C\\n--model\\n");',
      "  process.exit(0);",
      "}",
      'const outputPath = args[args.indexOf("--output-last-message") + 1];',
      'writeFileSync(outputPath, JSON.stringify({ summary: "ok" }), "utf8");',
      'const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 60000)"], { stdio: ["ignore", "ignore", "ignore", 3] });',
      `writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid) + "\\n", "utf8");`,
      "process.exit(0);",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(executable, 0o700);
}

async function writeSuccessfulDescendantProvider(
  executable: string,
  pidPath: string,
): Promise<void> {
  await writeFile(
    executable,
    [
      "#!/usr/bin/env node",
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'if (args.includes("--version")) { process.stdout.write("success-descendant 1.0.0\\n"); process.exit(0); }',
      'if (args.includes("--help")) {',
      '  process.stdout.write("--sandbox\\n--ephemeral\\n--json\\n--output-last-message\\n--output-schema\\n--ignore-user-config\\n--ignore-rules\\n--skip-git-repo-check\\n--color\\n-c\\n-C\\n--model\\n");',
      "  process.exit(0);",
      "}",
      'const outputPath = args[args.indexOf("--output-last-message") + 1];',
      'writeFileSync(outputPath, JSON.stringify({ summary: "ok" }), "utf8");',
      'const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 60000)"], { stdio: "ignore" });',
      "descendant.unref();",
      `writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid) + "\\n", "utf8");`,
      "process.exit(0);",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(executable, 0o700);
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      return Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("fake provider did not write its pid");
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`provider process ${String(pid)} is still alive`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function restoreEnvironment(
  previous: Record<string, string | undefined>,
): void {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
}

describe("process providers", () => {
  test("codex reads the bounded last-message stream and JSONL metadata", async () => {
    const codex = new CodexCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const result = await codex.review(baseRequest());
    expect(result.content).toMatchObject({ summary: "ok" });
    expect(result.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
    expect(result.providerRequestId).toBe("fake-thread");
  });

  test("codex keeps trusted auth while isolating user config and unrelated env", async () => {
    const directory = await temporaryDirectory("cq-codex-auth-");
    const previous = {
      CODEX_HOME: process.env.CODEX_HOME,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CQ_DANGEROUS_TEST_ENV: process.env.CQ_DANGEROUS_TEST_ENV,
    };
    process.env.CODEX_HOME = join(directory, "codex-home");
    process.env.OPENAI_API_KEY = "codex-auth-secret-value";
    process.env.CQ_DANGEROUS_TEST_ENV = "must-not-leak";
    try {
      const provider = new CodexCliProvider({
        executable: fakeCli,
        model: "test-model",
        allowedModels: ["test-model"],
      });
      const result = await provider.review(baseRequest());
      const content = result.content as {
        readonly environment?: Record<string, unknown>;
        readonly runtimeArgs?: readonly string[];
      };
      expect(content.environment).toMatchObject({
        codexHome: join(directory, "codex-home"),
        openAiApiKeyPresent: true,
        dangerousPresent: false,
      });
      expect(content.runtimeArgs).toEqual(
        expect.arrayContaining([
          "--ignore-user-config",
          "--ignore-rules",
          "shell_environment_policy.inherit=none",
        ]),
      );
      expect(JSON.stringify(content.runtimeArgs)).not.toContain(
        "codex-auth-secret-value",
      );
    } finally {
      restoreEnvironment(previous);
    }
  });

  test("codex redacts every forwarded credential from diagnostics", () => {
    const previous = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
    };
    process.env.OPENAI_API_KEY = "openai-forwarded-secret-value";
    process.env.CODEX_API_KEY = "codex-forwarded-secret-value";
    try {
      const provider = new CodexCliProvider({
        executable: fakeCli,
        model: "test-model",
        allowedModels: ["test-model"],
      });
      const diagnostic = provider.redactDiagnostic(
        "openai-forwarded-secret-value codex-forwarded-secret-value",
      );
      expect(diagnostic).not.toContain("openai-forwarded-secret-value");
      expect(diagnostic).not.toContain("codex-forwarded-secret-value");
      expect(diagnostic.match(/\[REDACTED\]/gu)).toHaveLength(2);
    } finally {
      restoreEnvironment(previous);
    }
  });

  test("claude receives a JSON schema string and reads structured_output", async () => {
    const claude = new ClaudeCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    expect(claude.capabilities().kind).toBe("claude_cli");
    const result = await claude.review(baseRequest());
    expect(result.content).toMatchObject({
      summary: "ok",
      schemaArgumentType: "json-string",
    });
    expect(result.usage?.totalTokens).toBe(7);
    expect(result.providerRequestId).toBe("fake-claude-session");
  });

  test("claude keeps standard login HOME while isolating unrelated env", async () => {
    const directory = await temporaryDirectory("cq-claude-auth-");
    const previous = {
      HOME: process.env.HOME,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      CQ_DANGEROUS_TEST_ENV: process.env.CQ_DANGEROUS_TEST_ENV,
    };
    process.env.HOME = directory;
    process.env.ANTHROPIC_API_KEY = "claude-auth-secret-value";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-oauth-secret-value";
    process.env.CQ_DANGEROUS_TEST_ENV = "must-not-leak";
    try {
      const provider = new ClaudeCliProvider({
        executable: fakeCli,
        model: "test-model",
        allowedModels: ["test-model"],
      });
      const result = await provider.review(baseRequest());
      const content = result.content as {
        readonly environment?: Record<string, unknown>;
        readonly runtimeArgs?: readonly string[];
      };
      expect(content.environment).toMatchObject({
        home: directory,
        anthropicApiKeyPresent: true,
        claudeOauthPresent: true,
        dangerousPresent: false,
      });
      expect(content.runtimeArgs).toContain("--safe-mode");
      expect(content.runtimeArgs).not.toContain("--bare");
      expect(JSON.stringify(content.runtimeArgs)).not.toContain(
        "claude-auth-secret-value",
      );
      expect(JSON.stringify(content.runtimeArgs)).not.toContain(
        "claude-oauth-secret-value",
      );
    } finally {
      restoreEnvironment(previous);
    }
  });

  test("claude redacts every forwarded credential from diagnostics", () => {
    const previous = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
    process.env.ANTHROPIC_API_KEY = "anthropic-forwarded-secret-value";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-forwarded-oauth-value";
    try {
      const provider = new ClaudeCliProvider({
        executable: fakeCli,
        model: "test-model",
        allowedModels: ["test-model"],
      });
      const diagnostic = provider.redactDiagnostic(
        "anthropic-forwarded-secret-value claude-forwarded-oauth-value",
      );
      expect(diagnostic).not.toContain("anthropic-forwarded-secret-value");
      expect(diagnostic).not.toContain("claude-forwarded-oauth-value");
      expect(diagnostic.match(/\[REDACTED\]/gu)).toHaveLength(2);
    } finally {
      restoreEnvironment(previous);
    }
  });

  test("bounds the Claude JSON schema command argument", async () => {
    const claude = new ClaudeCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    await expect(
      claude.review(
        baseRequest({
          outputSchema: {
            type: "object",
            description: "x".repeat(70 * 1024),
          },
          maxRequestBytes: 256 * 1024,
        }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE" });
  });

  test("rejects oversized process output while it is streaming", async () => {
    const provider = new ClaudeCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    await expect(
      provider.review(
        baseRequest({
          systemInstructions: "fixture-mode:oversized-stream",
          maxResponseBytes: 1_024,
        }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE" });
  });

  test("bounds the Codex output-last-message stream", async () => {
    const provider = new CodexCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    await expect(
      provider.review(
        baseRequest({
          systemInstructions: "fixture-mode:oversized-output-file",
          maxResponseBytes: 1_024,
        }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE" });
  });

  test.skipIf(process.platform === "win32")(
    "does not expose a regular-file sink for Codex last-message output",
    async () => {
      const directory = await temporaryDirectory("cq-provider-output-sink-");
      const executable = join(directory, "flooding-cli.mjs");
      const evidencePath = join(directory, "sink.json");
      await writeFloodingOutputProvider(executable, evidencePath);
      const provider = new CodexCliProvider({
        executable,
        model: "test-model",
        allowedModels: ["test-model"],
      });

      await expect(
        provider.review(baseRequest({ maxResponseBytes: 1_024 })),
      ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE" });
      const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
        readonly isFile: boolean;
        readonly isFIFO: boolean;
        readonly isSocket: boolean;
      };
      expect(evidence.isFile).toBe(false);
      expect(evidence.isFIFO || evidence.isSocket).toBe(true);
    },
  );

  test.skipIf(process.platform === "win32")(
    "cleans a descendant that holds the output fd after provider exit",
    async () => {
      const directory = await temporaryDirectory("cq-provider-output-fd-");
      const executable = join(directory, "leaked-fd-cli.mjs");
      const pidPath = join(directory, "descendant.pid");
      await writeLeakedOutputFdProvider(executable, pidPath);
      const provider = new CodexCliProvider({
        executable,
        model: "test-model",
        allowedModels: ["test-model"],
      });
      const request = baseRequest({ timeoutMs: 500 });
      const session = await provider.openReviewSession({
        runId: request.runId,
        signal: request.signal,
        deadline: Date.now() + 5_000,
      });
      try {
        const review = provider.review(request);
        void review.catch(() => undefined);
        const pid = await waitForPid(pidPath);
        await expect(review).resolves.toMatchObject({
          content: { summary: "ok" },
        });
        await waitForProcessExit(pid);
      } finally {
        await session.release();
      }
    },
    7_000,
  );

  test.skipIf(process.platform === "win32")(
    "cleans descendants after a successful provider leader exits",
    async () => {
      const directory = await temporaryDirectory("cq-provider-success-child-");
      const executable = join(directory, "success-descendant-cli.mjs");
      const pidPath = join(directory, "descendant.pid");
      await writeSuccessfulDescendantProvider(executable, pidPath);
      const provider = new CodexCliProvider({
        executable,
        model: "test-model",
        allowedModels: ["test-model"],
      });

      await expect(provider.review(baseRequest())).resolves.toMatchObject({
        content: { summary: "ok" },
      });
      const pid = await waitForPid(pidPath);
      const descendantAliveAfterSuccess = processIsAlive(pid);
      try {
        expect(descendantAliveAfterSuccess).toBe(false);
      } finally {
        if (descendantAliveAfterSuccess) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The descendant may exit between the bounded wait and cleanup.
          }
          await waitForProcessExit(pid);
        }
      }
    },
    7_000,
  );

  test("terminates a Codex process while its last-message file is growing", async () => {
    const directory = await temporaryDirectory("cq-provider-file-growth-");
    const pidPath = join(directory, "provider.pid");
    const provider = new CodexCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const startedAt = Date.now();
    const review = provider.review(
      baseRequest({
        systemInstructions: [
          "fixture-mode:growing-output-file",
          `pid-file:${pidPath}`,
        ].join("\n"),
        maxResponseBytes: 1_024,
      }),
    );
    const pid = await waitForPid(pidPath);
    await expect(review).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_TOO_LARGE",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await waitForProcessExit(pid);
  });

  test("cancellation force-kills a process that ignores SIGTERM", async () => {
    const directory = await temporaryDirectory("cq-provider-kill-");
    const pidPath = join(directory, "provider.pid");
    const controller = new AbortController();
    const provider = new ClaudeCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const review = provider.review(
      baseRequest({
        systemInstructions: [
          "fixture-mode:ignore-sigterm",
          `pid-file:${pidPath}`,
        ].join("\n"),
        signal: controller.signal,
      }),
    );
    const pid = await waitForPid(pidPath);
    controller.abort();
    await expect(review).rejects.toMatchObject({ code: "PROVIDER_ABORTED" });
    await waitForProcessExit(pid);
  });

  test("cancels a cold provider probe and force-kills its process", async () => {
    const directory = await temporaryDirectory("cq-provider-probe-abort-");
    const executable = join(directory, "fake-cli.mjs");
    const pidPath = join(directory, "probe.pid");
    await writeHangingProbe(executable, pidPath);
    const controller = new AbortController();
    const provider = new CodexCliProvider({
      executable,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const review = provider.review(baseRequest({ signal: controller.signal }));
    const pid = await waitForPid(pidPath);
    const abortedAt = Date.now();
    controller.abort();
    await expect(review).rejects.toMatchObject({ code: "PROVIDER_ABORTED" });
    expect(Date.now() - abortedAt).toBeLessThan(500);
    await waitForProcessExit(pid);
  });

  test("maps a cold provider probe deadline to provider timeout", async () => {
    const directory = await temporaryDirectory("cq-provider-probe-timeout-");
    const executable = join(directory, "fake-cli.mjs");
    const pidPath = join(directory, "probe.pid");
    await writeHangingProbe(executable, pidPath);
    const provider = new CodexCliProvider({
      executable,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const startedAt = Date.now();
    const review = provider.review(baseRequest({ timeoutMs: 3_000 }));
    void review.catch(() => undefined);
    const pid = await waitForPid(pidPath);
    await expect(review).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    await waitForProcessExit(pid);
  }, 7_000);

  test("continues from the snapshot when the executable disappears after probing", async () => {
    const directory = await temporaryDirectory("cq-provider-spawn-");
    const executable = join(directory, "fake-cli.mjs");
    await writeSelfDeletingProvider(executable);
    const provider = new CodexCliProvider({
      executable,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    await expect(provider.review(baseRequest())).resolves.toMatchObject({
      content: { summary: "snapshot" },
    });
    await expect(access(executable)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("repairs malformed output with the validation failure and schema-only instruction", async () => {
    const provider = new CodexCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const result = await provider.review(
      baseRequest({ systemInstructions: "fixture-mode:invalid-once" }),
    );
    expect(result.attemptsUsed).toBe(2);
    expect(result.content).toMatchObject({ summary: "repaired" });
    const prompt = (result.content as { repairPrompt?: unknown }).repairPrompt;
    expect(prompt).toEqual(expect.any(String));
    expect(prompt).toContain("previous response failed validation");
    expect(prompt).toContain(
      "Return only valid JSON matching the supplied schema",
    );
  });

  test("repairs syntactically valid process output that violates the requested schema", async () => {
    const provider = new CodexCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const result = await provider.review(
      baseRequest({
        systemInstructions: "fixture-mode:schema-invalid-once",
        outputSchema: {
          type: "object",
          required: ["summary"],
          properties: { summary: { type: "string" } },
        },
      }),
    );
    expect(result.attemptsUsed).toBe(2);
    expect(result.content).toMatchObject({ summary: "repaired" });
  });

  test("repairs process output with invalid usage metadata", async () => {
    const provider = new ClaudeCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const result = await provider.review(
      baseRequest({ systemInstructions: "fixture-mode:usage-invalid-once" }),
    );
    expect(result.attemptsUsed).toBe(2);
    expect(result.usage).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    });
  });

  test("does not repair malformed output after the attempt budget is consumed", async () => {
    const provider = new ClaudeCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    await expect(
      provider.review(
        baseRequest({
          systemInstructions: "fixture-mode:invalid-once",
          attemptBudget: { maxAttempts: 2, used: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  test("rejects non-absolute executables", async () => {
    const codex = new CodexCliProvider({
      executable: "git",
      model: "test-model",
      allowedModels: ["test-model"],
    });
    await expect(codex.validateConfiguration()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PROVIDER_EXECUTABLE_INVALID" }),
      ]),
    );
  });
});
