import {
  appendFile,
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  CLAUDE_REQUIRED_FLAGS,
  CODEX_REQUIRED_FLAGS,
  probeProcessProvider,
  probeProcessProviderResult,
} from "../../../src/providers/probe.js";
import {
  MAX_CONCURRENT_PROBE_CHILDREN,
  ProbeChildCapacity,
} from "../../../src/providers/probe-capacity.js";

const fakeCli = fileURLToPath(
  new URL("../../fixtures/providers/fake-cli.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function copyFakeCli(prefix: string): Promise<{
  readonly directory: string;
  readonly executable: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  const executable = join(directory, "fake-cli.mjs");
  await copyFile(fakeCli, executable);
  await chmod(executable, 0o700);
  return { directory, executable };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`fixture did not write ${path}`);
}

describe("provider probe", () => {
  test("accepts fake cli that advertises required flags", async () => {
    const diagnostics = await probeProcessProvider({
      kind: "codex_cli",
      executable: fakeCli,
      requiredFlags: ["--sandbox", "--ephemeral", "--json"],
    });
    expect(
      diagnostics.filter((item) => item.code !== "PROVIDER_PROBE_FAILED"),
    ).toEqual([]);
  });

  test("requires every runtime isolation and structured-output flag", async () => {
    expect(CODEX_REQUIRED_FLAGS).toEqual(
      expect.arrayContaining([
        "--sandbox",
        "--ephemeral",
        "--json",
        "--output-last-message",
        "--output-schema",
        "--ignore-user-config",
        "--ignore-rules",
        "-c",
        "--model",
      ]),
    );
    expect(CLAUDE_REQUIRED_FLAGS).toEqual(
      expect.arrayContaining([
        "--print",
        "--safe-mode",
        "--tools",
        "--permission-mode",
        "--output-format",
        "--json-schema",
        "--model",
        "--no-session-persistence",
      ]),
    );

    const { directory, executable } = await copyFakeCli("cq-probe-flags-");
    await writeFile(
      join(directory, "omit-flag.txt"),
      "--output-last-message\n",
      "utf8",
    );
    const diagnostics = await probeProcessProvider({
      kind: "codex_cli",
      executable,
      requiredFlags: CODEX_REQUIRED_FLAGS,
    });
    const missingFlag = diagnostics.find(
      (diagnostic) => diagnostic.code === "PROVIDER_SAFE_MODE_UNSUPPORTED",
    );
    expect(missingFlag?.message).toContain("--output-last-message");
  });

  test("matches required flags as exact option tokens", async () => {
    const { directory, executable } = await copyFakeCli(
      "cq-probe-exact-flags-",
    );
    await writeFile(join(directory, "omit-flag.txt"), "-c\n", "utf8");

    const diagnostics = await probeProcessProvider({
      kind: "codex_cli",
      executable,
      requiredFlags: CODEX_REQUIRED_FLAGS,
    });

    const missingFlag = diagnostics.find(
      (diagnostic) => diagnostic.code === "PROVIDER_SAFE_MODE_UNSUPPORTED",
    );
    expect(missingFlag?.message).toContain("-c");
  });

  test("caches help by resolved executable version and invalidates on replacement", async () => {
    const { directory, executable } = await copyFakeCli("cq-probe-cache-");
    const alias = join(directory, "fake-cli-alias.mjs");
    const countPath = join(directory, "probe-count.txt");
    const versionCountPath = join(directory, "version-count.txt");
    await symlink(executable, alias);
    await writeFile(countPath, "0\n", "utf8");
    await writeFile(versionCountPath, "0\n", "utf8");
    const request = {
      kind: "codex_cli" as const,
      requiredFlags: CODEX_REQUIRED_FLAGS,
    };

    await probeProcessProvider({ ...request, executable });
    await probeProcessProvider({ ...request, executable: alias });
    expect((await readFile(countPath, "utf8")).trim()).toBe("1");
    expect((await readFile(versionCountPath, "utf8")).trim()).toBe("1");

    await appendFile(executable, "\n", "utf8");
    await probeProcessProvider({ ...request, executable });
    expect((await readFile(countPath, "utf8")).trim()).toBe("2");
    expect((await readFile(versionCountPath, "utf8")).trim()).toBe("2");
  });

  test("rejects relative executables", async () => {
    const diagnostics = await probeProcessProvider({
      kind: "claude_cli",
      executable: "claude",
      requiredFlags: ["--print"],
    });
    expect(diagnostics[0]?.code).toBe("PROVIDER_EXECUTABLE_INVALID");
  });

  test("does not spawn a cold probe for a pre-cancelled caller", async () => {
    const { directory, executable } = await copyFakeCli("cq-probe-preabort-");
    const versionCountPath = join(directory, "version-count.txt");
    await writeFile(versionCountPath, "0\n", "utf8");
    const controller = new AbortController();
    controller.abort();
    const result = await probeProcessProviderResult({
      kind: "codex_cli",
      executable,
      requiredFlags: CODEX_REQUIRED_FLAGS,
      signal: controller.signal,
    });
    expect(result.terminal).toBe("aborted");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await readFile(versionCountPath, "utf8")).trim()).toBe("0");
  });

  test("does not reuse an aborted probe while its child is still closing", async () => {
    const { directory, executable } = await copyFakeCli("cq-probe-retired-");
    await writeFile(
      join(directory, "probe-mode.txt"),
      "first-version-hang-then-ok\n",
      "utf8",
    );
    const controller = new AbortController();
    const request = {
      kind: "codex_cli" as const,
      executable,
      requiredFlags: CODEX_REQUIRED_FLAGS,
    };
    const cancelled = probeProcessProviderResult({
      ...request,
      signal: controller.signal,
    });
    await waitForFile(join(directory, "probe.pid"));
    controller.abort();
    await waitForFile(join(directory, "probe.sigterm"));

    const live = await probeProcessProviderResult(request);
    await expect(cancelled).resolves.toMatchObject({ terminal: "aborted" });
    expect(live.terminal).toBeUndefined();
    expect(live.diagnostics).toEqual([]);
    expect(
      (
        await readFile(join(directory, "probe-attempt-count.txt"), "utf8")
      ).trim(),
    ).toBe("2");
  });

  test("caps global in-flight probe child permits at 128", () => {
    const capacity = new ProbeChildCapacity();
    const releases = Array.from({ length: MAX_CONCURRENT_PROBE_CHILDREN }, () =>
      capacity.tryAcquire(),
    );

    expect(releases.every((release) => release !== undefined)).toBe(true);
    expect(capacity.activeCount()).toBe(MAX_CONCURRENT_PROBE_CHILDREN);
    expect(capacity.tryAcquire()).toBeUndefined();

    releases[0]?.();
    releases[0]?.();
    expect(capacity.activeCount()).toBe(MAX_CONCURRENT_PROBE_CHILDREN - 1);
    expect(capacity.tryAcquire()).toEqual(expect.any(Function));
  });
});
