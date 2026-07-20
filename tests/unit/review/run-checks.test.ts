import { describe, expect, test } from "vitest";
import { tmpdir } from "node:os";

import {
  runAuthorizedChecks,
  RunChecksError,
} from "../../../src/review/run-checks.js";

describe("run-checks", () => {
  test("requires authorization and can preview only", async () => {
    await expect(
      runAuthorizedChecks({
        authorized: false,
        commands: [
          {
            label: "echo",
            argv: ["echo", "hi"],
            cwd: tmpdir(),
            timeoutMs: 1000,
            maxStdoutBytes: 1024,
            maxStderrBytes: 1024,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "RUN_CHECKS_UNAUTHORIZED",
    } satisfies Partial<RunChecksError>);

    const preview = await runAuthorizedChecks({
      authorized: true,
      previewOnly: true,
      commands: [
        {
          label: "echo",
          argv: ["echo", "hi"],
          cwd: tmpdir(),
          timeoutMs: 1000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
        },
      ],
    });
    expect(preview.preview).toContain("echo");
    expect(preview.results).toBeUndefined();
  });

  test("executes a bounded authorized command", async () => {
    const result = await runAuthorizedChecks({
      authorized: true,
      commands: [
        {
          label: "true",
          argv: ["true"],
          cwd: tmpdir(),
          timeoutMs: 1000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
        },
      ],
    });
    expect(result.results?.[0]?.exitCode).toBe(0);
  });

  test("enforces one wall-clock deadline across sequential checks", async () => {
    const startedAt = Date.now();
    const result = await runAuthorizedChecks({
      authorized: true,
      totalTimeoutMs: 150,
      commands: ["first", "second"].map((label) => ({
        label,
        argv: [process.execPath, "-e", "setTimeout(() => {}, 100)"],
        cwd: tmpdir(),
        timeoutMs: 1_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
      })),
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.results).toHaveLength(2);
    expect(result.results?.[1]?.timedOut).toBe(true);
  });

  test("force-kills a check that ignores SIGTERM", async () => {
    const result = await runAuthorizedChecks({
      authorized: true,
      totalTimeoutMs: 500,
      commands: [
        {
          label: "resistant",
          argv: [
            process.execPath,
            "-e",
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
          ],
          cwd: tmpdir(),
          timeoutMs: 50,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
        },
      ],
    });

    expect(result.results?.[0]).toMatchObject({
      exitCode: null,
      timedOut: true,
      failureReason: "timeout",
    });
  });

  test("terminates a check as soon as its output cap is exceeded", async () => {
    const result = await runAuthorizedChecks({
      authorized: true,
      totalTimeoutMs: 1_000,
      commands: [
        {
          label: "noisy",
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)",
          ],
          cwd: tmpdir(),
          timeoutMs: 800,
          maxStdoutBytes: 64,
          maxStderrBytes: 64,
        },
      ],
    });

    expect(result.results?.[0]).toMatchObject({
      exitCode: null,
      truncated: true,
      failureReason: "stdout_limit",
    });
  });

  test("reports an unresolved executable without hanging", async () => {
    const result = await runAuthorizedChecks({
      authorized: true,
      commands: [
        {
          label: "missing",
          argv: ["cq-executable-that-does-not-exist"],
          cwd: tmpdir(),
          timeoutMs: 100,
          maxStdoutBytes: 64,
          maxStderrBytes: 64,
        },
      ],
    });

    expect(result.results?.[0]).toMatchObject({
      exitCode: null,
      failureReason: "spawn",
    });
  });

  test("cancels the active process group", async () => {
    const controller = new AbortController();
    const running = runAuthorizedChecks({
      authorized: true,
      signal: controller.signal,
      commands: [
        {
          label: "cancelled",
          argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
          cwd: tmpdir(),
          timeoutMs: 1_000,
          maxStdoutBytes: 64,
          maxStderrBytes: 64,
        },
      ],
    });
    setTimeout(() => {
      controller.abort();
    }, 20);

    await expect(running).rejects.toMatchObject({
      code: "RUN_CHECKS_ABORTED",
    } satisfies Partial<RunChecksError>);
  });
});
