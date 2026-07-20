import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

const cleanupState = vi.hoisted(() => ({
  fail: false,
  calls: 0,
  directories: [] as string[],
}));

vi.mock(
  "../../../src/providers/executable-snapshot.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/providers/executable-snapshot.js")
      >();
    return {
      ...actual,
      createExecutableSnapshot: (
        options: Parameters<typeof actual.createExecutableSnapshot>[0],
      ) =>
        actual.createExecutableSnapshot({
          ...options,
          removeDirectory: async (path: string): Promise<void> => {
            cleanupState.calls += 1;
            cleanupState.directories.push(path);
            if (cleanupState.fail) {
              throw new Error("controlled provider snapshot cleanup failure");
            }
            await rm(path, { force: true, recursive: true });
          },
        }),
    };
  },
);

import { CodexCliProvider } from "../../../src/providers/codex-cli.js";

const fakeCli = fileURLToPath(
  new URL("../../fixtures/providers/fake-cli.mjs", import.meta.url),
);

async function openSession(provider: CodexCliProvider, runId: string) {
  return provider.openReviewSession({
    runId,
    signal: new AbortController().signal,
    deadline: Date.now() + 5_000,
  });
}

afterEach(async () => {
  cleanupState.fail = false;
  cleanupState.calls = 0;
  Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
  await Promise.all(
    cleanupState.directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("process provider resource release", () => {
  test("retries real snapshot cleanup before releasing capacity and secrets", async () => {
    const secret = "provider-resource-release-secret";
    process.env.OPENAI_API_KEY = secret;
    const provider = new CodexCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const first = await openSession(provider, "resource-release-1");
    Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    cleanupState.fail = true;

    await expect(first.release()).rejects.toMatchObject({
      code: "PROVIDER_UNSAFE",
    });
    expect(cleanupState.calls).toBe(1);
    expect(provider.redactDiagnostic(secret)).toBe("[REDACTED]");

    cleanupState.fail = false;
    const second = await openSession(provider, "resource-release-2");
    await expect(
      openSession(provider, "resource-release-3"),
    ).rejects.toMatchObject({ code: "PROVIDER_CAPACITY" });

    await first.release();
    expect(cleanupState.calls).toBe(2);
    expect(provider.redactDiagnostic(secret)).toBe(secret);
    const recovered = await openSession(provider, "resource-release-3");
    await Promise.all([second.release(), recovered.release()]);
  }, 15_000);
});
