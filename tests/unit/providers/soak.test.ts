import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  captureProcessVersion,
  PROVIDER_ADAPTER_VERSION,
  soakUserProviders,
} from "../../../src/providers/soak.js";

const fakeCli = fileURLToPath(
  new URL("../../fixtures/providers/fake-cli.mjs", import.meta.url),
);

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("external network is forbidden in provider soak unit tests"),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return (await readFile(path, "utf8")).trim();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`fixture did not write ${path}`);
}

async function waitForProcessExit(pid: number, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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

describe("provider soak", () => {
  test("captures process version from fake cli", async () => {
    const version = await captureProcessVersion(fakeCli);
    expect(version).toMatch(/fake-cli/u);
  });

  test("bounds and force-kills a version probe that ignores SIGTERM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-soak-version-kill-"));
    const executable = join(directory, "fake-cli.mjs");
    await copyFile(fakeCli, executable);
    await chmod(executable, 0o700);
    await writeFile(
      join(directory, "probe-mode.txt"),
      "version-stream-ignore-sigterm\n",
      "utf8",
    );
    let pid: number | undefined;
    try {
      const version = captureProcessVersion(executable, 2_000);
      pid = Number.parseInt(
        await waitForFile(join(directory, "probe.pid")),
        10,
      );
      await expect(version).resolves.toBeUndefined();
      await waitForProcessExit(pid);
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The bounded implementation already stopped it.
        }
      }
      await rm(directory, { force: true, recursive: true });
    }
  }, 10_000);

  test("soak reuses the bounded probe version result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-soak-version-once-"));
    const executable = join(directory, "fake-cli.mjs");
    const configPath = join(directory, "config.yaml");
    await copyFile(fakeCli, executable);
    await chmod(executable, 0o700);
    await writeFile(join(directory, "probe-count.txt"), "0\n", "utf8");
    await writeFile(join(directory, "version-count.txt"), "0\n", "utf8");
    await writeFile(
      configPath,
      [
        'schemaVersion: "1"',
        "providers:",
        "  - name: fake-once",
        "    kind: codex_cli",
        `    executable: ${JSON.stringify(executable)}`,
        "    defaultModel: m1",
        "    allowedModels: [m1]",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const report = await soakUserProviders({ configPath });
      expect(report.ok).toBe(true);
      expect(
        (await readFile(join(directory, "probe-count.txt"), "utf8")).trim(),
      ).toBe("1");
      expect(
        (await readFile(join(directory, "version-count.txt"), "utf8")).trim(),
      ).toBe("1");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("soakUserProviders probes codex_cli without repository content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-soak-"));
    const configPath = join(directory, "config.yaml");
    await writeFile(
      configPath,
      [
        'schemaVersion: "1"',
        "providers:",
        "  - name: fake",
        "    kind: codex_cli",
        `    executable: ${JSON.stringify(fakeCli)}`,
        "    defaultModel: m1",
        "    allowedModels: [m1]",
        "",
      ].join("\n"),
      "utf8",
    );
    const report = await soakUserProviders({ configPath });
    expect(report.ok).toBe(true);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.adapterVersion).toBe(PROVIDER_ADAPTER_VERSION);
    expect(report.entries[0]?.version).toMatch(/fake-cli/u);
    expect(report.entries[0]?.diagnostics).toEqual([]);
  });

  test("soakUserProviders fails when executable is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-soak-miss-"));
    const configPath = join(directory, "config.yaml");
    await writeFile(
      configPath,
      [
        'schemaVersion: "1"',
        "providers:",
        "  - name: missing",
        "    kind: claude_cli",
        "    executable: /tmp/definitely-missing-cq-provider-binary",
        "    defaultModel: m1",
        "    allowedModels: [m1]",
        "",
      ].join("\n"),
      "utf8",
    );
    const report = await soakUserProviders({ configPath });
    expect(report.ok).toBe(false);
    expect(report.entries[0]?.ok).toBe(false);
    expect(
      report.entries[0]?.diagnostics.some(
        (item) => item.code === "PROVIDER_EXECUTABLE_MISSING",
      ),
    ).toBe(true);
  });

  test("never auto-probes CQ_FORGE_TOKEN when forge options are absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-soak-no-auto-forge-"));
    const configPath = join(directory, "config.yaml");
    await writeFile(
      configPath,
      [
        'schemaVersion: "1"',
        "providers:",
        "  - name: fake",
        "    kind: codex_cli",
        `    executable: ${JSON.stringify(fakeCli)}`,
        "    defaultModel: m1",
        "    allowedModels: [m1]",
        "",
      ].join("\n"),
      "utf8",
    );
    const fetchImpl = vi.fn<typeof fetch>();
    try {
      const report = await soakUserProviders({
        configPath,
        env: {
          CQ_PROVIDER_LIVE_SOAK: "1",
          CQ_FORGE_TOKEN: "must-not-be-probed-token",
        },
        skipProviders: true,
        forgeFetchImpl: fetchImpl,
      });
      expect(report.entries).toEqual([]);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("requires forge and token env together before a live forge probe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-soak-forge-pair-"));
    const configPath = join(directory, "config.yaml");
    await writeFile(
      configPath,
      [
        'schemaVersion: "1"',
        "providers:",
        "  - name: fake",
        "    kind: codex_cli",
        `    executable: ${JSON.stringify(fakeCli)}`,
        "    defaultModel: m1",
        "    allowedModels: [m1]",
        "",
      ].join("\n"),
      "utf8",
    );
    const fetchImpl = vi.fn<typeof fetch>();
    try {
      const report = await soakUserProviders({
        configPath,
        env: { CQ_GITLAB_TOKEN: "gitlab-explicit-token" },
        live: true,
        forgeTokenEnv: "CQ_GITLAB_TOKEN",
        skipProviders: true,
        forgeFetchImpl: fetchImpl,
      });
      expect(report.ok).toBe(false);
      expect(report.entries[0]?.diagnostics[0]?.code).toBe(
        "FORGE_PROBE_CONFIG_INVALID",
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
