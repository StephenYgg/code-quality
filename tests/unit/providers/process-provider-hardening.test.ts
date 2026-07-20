import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { CodexCliProvider } from "../../../src/providers/codex-cli.js";
import type {
  ProviderReviewRequest,
  ReviewProvider,
  ReviewProviderSession,
} from "../../../src/providers/provider.js";

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
      {
        role: "untrusted",
        label: "code",
        text: "SOURCE_SENTINEL_MUST_NOT_REACH_REPLACEMENT",
      },
    ],
    outputSchema: { type: "object" },
    maxOutputTokens: 100,
    timeoutMs: 2_000,
    maxRequestBytes: 64 * 1024,
    maxResponseBytes: 64 * 1024,
    maxDiagnosticBytes: 16 * 1024,
    signal: new AbortController().signal,
    attemptBudget: { maxAttempts: 1, used: 0 },
    ...overrides,
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`fixture did not write ${path}`);
}

async function waitForMissing(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      await new Promise((resolve) => setTimeout(resolve, 5));
    } catch {
      return;
    }
  }
  throw new Error(`fixture did not remove ${path}`);
}

async function setupBarrier(): Promise<{
  readonly directory: string;
  readonly trusted: string;
  readonly malicious: string;
  readonly marker: string;
  readonly invocationLog: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "cq-provider-attestation-"));
  temporaryDirectories.push(directory);
  const trusted = join(directory, "trusted-cli.mjs");
  const malicious = join(directory, "malicious-cli.mjs");
  const marker = join(directory, "malicious-input.json");
  const invocationLog = join(directory, "invocations.txt");
  const ready = join(directory, "probe.ready");
  const release = join(directory, "probe.release");
  await writeFile(
    trusted,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";',
      `const invocationLog = ${JSON.stringify(invocationLog)};`,
      `const ready = ${JSON.stringify(ready)};`,
      `const release = ${JSON.stringify(release)};`,
      'appendFileSync(invocationLog, `${process.argv[1]}\\n`, "utf8");',
      "const args = process.argv.slice(2);",
      'if (args.includes("--version")) { process.stdout.write("trusted 1.0.0\\n"); process.exit(0); }',
      'if (args.includes("--help")) {',
      '  writeFileSync(ready, "ready\\n", "utf8");',
      "  while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 5));",
      '  process.stdout.write("--sandbox\\n--ephemeral\\n--json\\n--output-last-message\\n--output-schema\\n--ignore-user-config\\n--ignore-rules\\n--skip-git-repo-check\\n--color\\n-c\\n-C\\n--model\\n");',
      "  process.exit(0);",
      "}",
      'let stdin = "";',
      'process.stdin.setEncoding("utf8");',
      "for await (const chunk of process.stdin) stdin += chunk;",
      'const request = JSON.parse(stdin.split("\\n", 1)[0] ?? "{}");',
      'const outputPath = args[args.indexOf("--output-last-message") + 1];',
      "const mode = (statSync(outputPath).mode & 0o777).toString(8);",
      'if (request.systemInstructions === "fixture-mode:fail") process.exit(2);',
      'const repairing = stdin.includes("previous response failed validation");',
      'const content = request.systemInstructions === "fixture-mode:invalid-once" && !repairing ? {} : { summary: "trusted", outputFileMode: mode, credential: process.env.OPENAI_API_KEY ?? null };',
      'writeFileSync(outputPath, JSON.stringify(content), "utf8");',
      'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "trusted-thread" })}\\n`);',
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(trusted, 0o700);
  await writeFile(
    malicious,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
      "  credential: process.env.OPENAI_API_KEY ?? null,",
      "  stdin: await new Promise((resolve) => {",
      '    let value = "";',
      '    process.stdin.setEncoding("utf8");',
      '    process.stdin.on("data", (chunk) => { value += chunk; });',
      '    process.stdin.on("end", () => resolve(value));',
      "  }),",
      '}), "utf8");',
      "process.exit(2);",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  return { directory, trusted, malicious, marker, invocationLog };
}

async function openSession(
  provider: ReviewProvider,
  runId: string,
): Promise<ReviewProviderSession> {
  if (provider.openReviewSession === undefined) {
    throw new Error("process provider does not implement review sessions");
  }
  return provider.openReviewSession({
    runId,
    signal: new AbortController().signal,
    deadline: Date.now() + 2_000,
  });
}

async function expectNoMaliciousInput(marker: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
}

async function readPid(path: string): Promise<number> {
  await waitForFile(path);
  return Number.parseInt((await readFile(path, "utf8")).trim(), 10);
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

function forceKill(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The bounded implementation already stopped it.
  }
}

afterEach(async () => {
  Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("process provider executable snapshot", () => {
  test("uses one private snapshot when the configured executable changes after probe", async () => {
    const { directory, trusted, malicious, marker, invocationLog } =
      await setupBarrier();
    process.env.OPENAI_API_KEY = "CREDENTIAL_SENTINEL_MUST_NOT_LEAK";
    const provider = new CodexCliProvider({
      executable: trusted,
      model: "test-model",
      allowedModels: ["test-model"],
    });

    const review = provider.review(baseRequest());
    await waitForFile(join(directory, "probe.ready"));
    await rename(malicious, trusted);
    await writeFile(join(directory, "probe.release"), "release\n", "utf8");

    await expect(review).resolves.toMatchObject({
      content: { summary: "trusted" },
    });
    await expectNoMaliciousInput(marker);
    const invocations = (await readFile(invocationLog, "utf8"))
      .trim()
      .split("\n");
    expect(invocations).toHaveLength(3);
    expect(new Set(invocations).size).toBe(1);
    expect(invocations[0]).not.toBe(trusted);
    await expect(access(invocations[0] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("reference-counts one run snapshot and captures credentials once", async () => {
    const { directory, trusted, invocationLog } = await setupBarrier();
    const runId = "00000000-0000-4000-8000-000000000002";
    process.env.OPENAI_API_KEY = "SESSION_CREDENTIAL_ORIGINAL";
    const provider = new CodexCliProvider({
      executable: trusted,
      model: "test-model",
      allowedModels: ["test-model"],
    });

    const firstPromise = openSession(provider, runId);
    await waitForFile(join(directory, "probe.ready"));
    const secondPromise = openSession(provider, runId);
    await writeFile(join(directory, "probe.release"), "release\n", "utf8");
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    await first.release();
    let snapshotPath = "";
    try {
      process.env.OPENAI_API_KEY = "SESSION_CREDENTIAL_CHANGED";
      const result = await provider.review(baseRequest({ runId }));

      expect(result.content).toMatchObject({
        summary: "trusted",
        credential: "SESSION_CREDENTIAL_ORIGINAL",
      });
      const invocations = (await readFile(invocationLog, "utf8"))
        .trim()
        .split("\n");
      expect(invocations).toHaveLength(3);
      expect(new Set(invocations).size).toBe(1);
      snapshotPath = invocations[0] ?? "";
      await access(snapshotPath);
    } finally {
      await second.release();
    }
    await expect(access(snapshotPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("bounds executable snapshots globally across provider instances", async () => {
    const firstProvider = new CodexCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const secondProvider = new CodexCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const first = await openSession(firstProvider, "run-capacity-1");
    const second = await openSession(firstProvider, "run-capacity-2");
    try {
      await expect(
        openSession(secondProvider, "run-capacity-3"),
      ).rejects.toMatchObject({ code: "PROVIDER_CAPACITY" });
      await first.release();
      const recovered = await openSession(secondProvider, "run-capacity-3");
      await recovered.release();
    } finally {
      await Promise.all([first.release(), second.release()]);
    }
  });

  test("uses the same snapshot for response repair", async () => {
    const { directory, trusted, invocationLog } = await setupBarrier();
    const provider = new CodexCliProvider({
      executable: trusted,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const review = provider.review(
      baseRequest({
        systemInstructions: "fixture-mode:invalid-once",
        outputSchema: {
          type: "object",
          required: ["summary"],
          properties: { summary: { type: "string" } },
        },
        attemptBudget: { maxAttempts: 2, used: 0 },
      }),
    );
    await waitForFile(join(directory, "probe.ready"));
    await writeFile(join(directory, "probe.release"), "release\n", "utf8");

    await expect(review).resolves.toMatchObject({ attemptsUsed: 2 });
    const invocations = (await readFile(invocationLog, "utf8"))
      .trim()
      .split("\n");
    expect(invocations).toHaveLength(4);
    expect(new Set(invocations).size).toBe(1);
  });

  test("removes the snapshot after a runtime failure", async () => {
    const { directory, trusted, invocationLog } = await setupBarrier();
    const provider = new CodexCliProvider({
      executable: trusted,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const review = provider.review(
      baseRequest({ systemInstructions: "fixture-mode:fail" }),
    );
    await waitForFile(join(directory, "probe.ready"));
    await writeFile(join(directory, "probe.release"), "release\n", "utf8");

    await expect(review).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
    const snapshotPath = (await readFile(invocationLog, "utf8"))
      .trim()
      .split("\n")[0];
    await expect(access(snapshotPath ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("aborts and cleans pending creation after its final waiter cancels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-provider-waiters-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "hanging-cli.mjs");
    const invocationLog = join(directory, "invocations.txt");
    const pidPath = join(directory, "probe.pid");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        'import { appendFileSync, writeFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(invocationLog)}, String(process.argv[1]) + "\\n", "utf8");`,
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid) + "\\n", "utf8");`,
        'process.on("SIGTERM", () => undefined);',
        "setInterval(() => undefined, 60_000);",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const provider = new CodexCliProvider({
      executable,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = provider.openReviewSession({
      runId: "pending-cancel-run",
      signal: firstController.signal,
      deadline: Date.now() + 5_000,
    });
    const second = provider.openReviewSession({
      runId: "pending-cancel-run",
      signal: secondController.signal,
      deadline: Date.now() + 5_000,
    });
    void first.catch(() => undefined);
    void second.catch(() => undefined);
    const pid = await readPid(pidPath);

    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: "PROVIDER_ABORTED" });
    expect(() => process.kill(pid, 0)).not.toThrow();
    secondController.abort();
    await expect(second).rejects.toMatchObject({ code: "PROVIDER_ABORTED" });
    await waitForProcessExit(pid);
    const snapshotPath = (await readFile(invocationLog, "utf8")).trim();
    await waitForMissing(snapshotPath);

    const recovered = new CodexCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const recoveredFirst = await recovered.openReviewSession({
      runId: "recovered-capacity-1",
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
    });
    const recoveredSecond = await recovered.openReviewSession({
      runId: "recovered-capacity-2",
      signal: new AbortController().signal,
      deadline: Date.now() + 5_000,
    });
    await Promise.all([recoveredFirst.release(), recoveredSecond.release()]);
  });
});

describe.skipIf(process.platform === "win32")(
  "process provider tree termination",
  () => {
    test.each([
      {
        name: "caller cancellation",
        mode: "grandchild-ignore-sigterm",
        expectedCode: "PROVIDER_ABORTED",
        act: (controller: AbortController) => {
          controller.abort();
        },
      },
      {
        name: "request timeout",
        mode: "grandchild-ignore-sigterm",
        expectedCode: "PROVIDER_TIMEOUT",
        timeoutMs: 500,
        act: () => {},
      },
      {
        name: "streaming overflow",
        mode: "grandchild-oversized-stream",
        expectedCode: "PROVIDER_RESPONSE_TOO_LARGE",
        maxResponseBytes: 1_024,
        act: () => {},
      },
    ])("kills parent and grandchild after $name", async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "cq-provider-tree-"));
      temporaryDirectories.push(directory);
      const parentPidPath = join(directory, "parent.pid");
      const childPidPath = join(directory, "child.pid");
      const controller = new AbortController();
      let parentPid: number | undefined;
      let childPid: number | undefined;
      let session: ReviewProviderSession | undefined;
      try {
        const provider = new CodexCliProvider({
          executable: fakeCli,
          model: "test-model",
          allowedModels: ["test-model"],
        });
        const runId = `tree-${scenario.name.replaceAll(" ", "-")}`;
        session = await provider.openReviewSession({
          runId,
          signal: new AbortController().signal,
          deadline: Date.now() + 5_000,
        });
        const review = provider.review(
          baseRequest({
            runId,
            systemInstructions: [
              `fixture-mode:${scenario.mode}`,
              `pid-file:${parentPidPath}`,
              `child-pid-file:${childPidPath}`,
            ].join("\n"),
            signal: controller.signal,
            timeoutMs: scenario.timeoutMs ?? 2_000,
            maxResponseBytes: scenario.maxResponseBytes ?? 64 * 1024,
          }),
        );
        void review.catch(() => undefined);
        parentPid = await readPid(parentPidPath);
        childPid = await readPid(childPidPath);
        scenario.act(controller);
        await expect(review).rejects.toMatchObject({
          code: scenario.expectedCode,
        });
        await waitForProcessExit(parentPid);
        await waitForProcessExit(childPid);
      } finally {
        forceKill(parentPid);
        forceKill(childPid);
        await session?.release();
      }
    });
  },
);
