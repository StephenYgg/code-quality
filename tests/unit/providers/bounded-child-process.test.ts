import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi, type MockInstance } from "vitest";

import { runBoundedChild } from "../../../src/providers/bounded-child-process.js";

const STALLED_SUPERVISOR_SOURCE = String.raw`
import { createReadStream, writeSync } from "node:fs";
createReadStream("/dev/null", { fd: 5, autoClose: false }).resume();
writeSync(4, JSON.stringify({ kind: "ready" }) + "\n", null, "utf8");
setTimeout(() => process.kill(-process.pid, "SIGKILL"), 250);
`;

function delayedCleanupSupervisor(pidPath: string): string {
  return String.raw`
import { spawn } from "node:child_process";
import { createReadStream, writeFileSync, writeSync } from "node:fs";
let started = false;
const control = createReadStream("/dev/null", { fd: 5, autoClose: false });
control.on("data", (chunk) => {
  const message = chunk.toString("utf8");
  if (!started && message.includes('"kind":"start"')) {
    started = true;
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 60_000)"], {
      stdio: "ignore",
    });
    writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid), "utf8");
    writeSync(4, JSON.stringify({ kind: "result", result: "exit", exitCode: 0 }) + "\n", null, "utf8");
    return;
  }
  if (message.includes('"kind":"ack"') || message.includes('"kind":"cancel"')) {
    const cleanupAt = Date.now() + 500;
    while (Date.now() < cleanupAt) {}
    process.kill(-process.pid, "SIGKILL");
  }
});
writeSync(4, JSON.stringify({ kind: "ready" }) + "\n", null, "utf8");
`;
}

function readyDeadlineBarrierSupervisor(markerPath: string): string {
  return String.raw`
import { createReadStream, writeFileSync, writeSync } from "node:fs";
let pending = "";
const control = createReadStream("/dev/null", { fd: 5, autoClose: false });
control.on("data", (chunk) => {
  pending += chunk.toString("utf8");
  while (pending.includes("\n")) {
    const newline = pending.indexOf("\n");
    const frame = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    if (frame.kind === "start") {
      writeFileSync(${JSON.stringify(markerPath)}, "started\n", "utf8");
      process.exit(0);
    }
    if (frame.kind === "cancel") process.exit(0);
  }
});
writeSync(4, JSON.stringify({ kind: "ready" }) + "\n", null, "utf8");
setTimeout(() => process.exit(0), 1_000);
`;
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`supervisor did not write ${path}`);
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
  throw new Error(`supervised descendant ${String(pid)} is still alive`);
}

function forceKill(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process has already exited.
  }
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
  throw new Error(`provider did not write ${path}`);
}

async function expectMissing(path: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

function negativePidSignals(
  kill: MockInstance<typeof process.kill>,
): readonly unknown[][] {
  return kill.mock.calls.filter((call) => {
    const pid = call[0];
    return typeof pid === "number" && pid < 0;
  });
}

function markerProviderSource(markerPath: string): string {
  return String.raw`
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerPath)}, "spawned\n", "utf8");
setInterval(() => undefined, 60_000);
`;
}

function responsiveTreeSource(paths: {
  readonly providerPid: string;
  readonly supervisorPid: string;
  readonly descendantPid: string;
  readonly providerTerm: string;
  readonly descendantTerm: string;
}): string {
  const descendant = String.raw`
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(paths.descendantPid)}, String(process.pid), "utf8");
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(paths.descendantTerm)}, "term\n", "utf8");
  process.exit(0);
});
setInterval(() => undefined, 60_000);
`;
  return String.raw`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(paths.providerPid)}, String(process.pid), "utf8");
writeFileSync(${JSON.stringify(paths.supervisorPid)}, String(process.ppid), "utf8");
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(paths.providerTerm)}, "term\n", "utf8");
  process.exit(0);
});
setInterval(() => undefined, 60_000);
`;
}

function ignoringTreeSource(descendantPidPath: string): string {
  const descendant = String.raw`
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid), "utf8");
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 60_000);
`;
  return String.raw`
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
setInterval(() => undefined, 60_000);
`;
}

function nodeEval(source: string): readonly string[] {
  return ["--input-type=module", "-e", source];
}

describe.skipIf(process.platform === "win32")(
  "bounded child process supervision",
  () => {
    test("does not signal a process group from the parent after success", async () => {
      const kill = vi.spyOn(process, "kill");
      try {
        await expect(
          runBoundedChild({
            executable: process.execPath,
            args: ["-e", "process.exit(0)"],
            env: { PATH: process.env.PATH ?? "" },
            timeoutMs: 2_000,
            maxStdoutBytes: 1_024,
            maxStderrBytes: 1_024,
            signal: new AbortController().signal,
          }),
        ).resolves.toMatchObject({ exitCode: 0 });

        const parentGroupSignals = kill.mock.calls.filter(
          ([pid]) => typeof pid === "number" && pid < 0,
        );
        expect(parentGroupSignals).toEqual([]);
      } finally {
        kill.mockRestore();
      }
    });

    test("keeps the request deadline active until supervisor cleanup completes", async () => {
      await expect(
        runBoundedChild({
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          env: { PATH: process.env.PATH ?? "" },
          timeoutMs: 100,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
          signal: new AbortController().signal,
          supervisorSource: STALLED_SUPERVISOR_SOURCE,
        }),
      ).rejects.toMatchObject({ reason: "timeout" });
    });

    test("lets a reported supervisor finish group cleanup after the deadline", async () => {
      const directory = await mkdtemp(join(tmpdir(), "cq-supervisor-race-"));
      const pidPath = join(directory, "descendant.pid");
      let descendantPid: number | undefined;
      try {
        const execution = runBoundedChild({
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          env: { PATH: process.env.PATH ?? "" },
          timeoutMs: 250,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
          signal: new AbortController().signal,
          supervisorSource: delayedCleanupSupervisor(pidPath),
        });
        void execution.catch(() => undefined);
        descendantPid = await waitForPid(pidPath);

        await expect(execution).rejects.toMatchObject({ reason: "timeout" });
        await waitForProcessExit(descendantPid);
      } finally {
        forceKill(descendantPid);
        await rm(directory, { force: true, recursive: true });
      }
    });

    test("cancels before READY without spawning or parent group signals", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "cq-supervisor-pre-ready-"),
      );
      const markerPath = join(directory, "provider.spawned");
      const controller = new AbortController();
      const kill = vi.spyOn(process, "kill");
      try {
        const execution = runBoundedChild({
          executable: process.execPath,
          args: nodeEval(markerProviderSource(markerPath)),
          env: { PATH: process.env.PATH ?? "" },
          timeoutMs: 2_000,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
          signal: controller.signal,
        });
        void execution.catch(() => undefined);
        controller.abort();

        await expect(execution).rejects.toMatchObject({ reason: "aborted" });
        await expectMissing(markerPath);
        expect(negativePidSignals(kill)).toEqual([]);
      } finally {
        kill.mockRestore();
        await rm(directory, { force: true, recursive: true });
      }
    });

    test("cancels after READY but before START without spawning", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "cq-supervisor-pre-start-"),
      );
      const markerPath = join(directory, "provider.spawned");
      const controller = new AbortController();
      const kill = vi.spyOn(process, "kill");
      let monitorStarted = false;
      try {
        const execution = runBoundedChild({
          executable: process.execPath,
          args: nodeEval(markerProviderSource(markerPath)),
          env: { PATH: process.env.PATH ?? "" },
          timeoutMs: 2_000,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
          signal: controller.signal,
          startMonitor: () => {
            monitorStarted = true;
            controller.abort();
            return () => undefined;
          },
        });
        void execution.catch(() => undefined);

        await expect(execution).rejects.toMatchObject({ reason: "aborted" });
        expect(monitorStarted).toBe(true);
        await expectMissing(markerPath);
        expect(negativePidSignals(kill)).toEqual([]);
      } finally {
        kill.mockRestore();
        await rm(directory, { force: true, recursive: true });
      }
    });

    test("does not START after a READY monitor crosses the deadline", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "cq-supervisor-ready-deadline-"),
      );
      const markerPath = join(directory, "provider.started");
      const kill = vi.spyOn(process, "kill");
      try {
        const execution = runBoundedChild({
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          env: { PATH: process.env.PATH ?? "" },
          timeoutMs: 100,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
          signal: new AbortController().signal,
          supervisorSource: readyDeadlineBarrierSupervisor(markerPath),
          startMonitor: () => {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
            return () => undefined;
          },
        });

        await expect(execution).rejects.toMatchObject({ reason: "timeout" });
        await expectMissing(markerPath);
        expect(negativePidSignals(kill)).toEqual([]);
      } finally {
        kill.mockRestore();
        await rm(directory, { force: true, recursive: true });
      }
    });

    test("keeps the supervisor owner alive through the TERM grace period", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "cq-supervisor-term-owner-"),
      );
      const paths = {
        providerPid: join(directory, "provider.pid"),
        supervisorPid: join(directory, "supervisor.pid"),
        descendantPid: join(directory, "descendant.pid"),
        providerTerm: join(directory, "provider.term"),
        descendantTerm: join(directory, "descendant.term"),
      };
      const controller = new AbortController();
      const kill = vi.spyOn(process, "kill");
      let providerPid: number | undefined;
      let supervisorPid: number | undefined;
      let descendantPid: number | undefined;
      try {
        const execution = runBoundedChild({
          executable: process.execPath,
          args: nodeEval(responsiveTreeSource(paths)),
          env: { PATH: process.env.PATH ?? "" },
          timeoutMs: 2_000,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
          signal: controller.signal,
        });
        void execution.catch(() => undefined);
        const observedPids = await Promise.all([
          waitForPid(paths.providerPid),
          waitForPid(paths.supervisorPid),
          waitForPid(paths.descendantPid),
        ]);
        [providerPid, supervisorPid, descendantPid] = observedPids;

        controller.abort();
        await Promise.all([
          waitForFile(paths.providerTerm),
          waitForFile(paths.descendantTerm),
        ]);
        expect(() => process.kill(observedPids[1], 0)).not.toThrow();
        await expect(execution).rejects.toMatchObject({ reason: "aborted" });
        await Promise.all([
          waitForProcessExit(providerPid),
          waitForProcessExit(supervisorPid),
          waitForProcessExit(descendantPid),
        ]);
        expect(negativePidSignals(kill)).toEqual([]);
      } finally {
        forceKill(providerPid);
        forceKill(supervisorPid);
        forceKill(descendantPid);
        kill.mockRestore();
        await rm(directory, { force: true, recursive: true });
      }
    });

    test("waits for an unmonitored TERM-ignoring descendant to be killed", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "cq-supervisor-unmonitored-"),
      );
      const descendantPidPath = join(directory, "descendant.pid");
      const controller = new AbortController();
      const kill = vi.spyOn(process, "kill");
      let descendantPid: number | undefined;
      try {
        const execution = runBoundedChild({
          executable: process.execPath,
          args: nodeEval(ignoringTreeSource(descendantPidPath)),
          env: { PATH: process.env.PATH ?? "" },
          timeoutMs: 2_000,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
          signal: controller.signal,
        });
        void execution.catch(() => undefined);
        descendantPid = await waitForPid(descendantPidPath);

        controller.abort();
        await expect(execution).rejects.toMatchObject({ reason: "aborted" });
        await waitForProcessExit(descendantPid);
        expect(negativePidSignals(kill)).toEqual([]);
      } finally {
        forceKill(descendantPid);
        kill.mockRestore();
        await rm(directory, { force: true, recursive: true });
      }
    });

    test("enforces the absolute deadline while the parent event loop is blocked", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "cq-supervisor-blocked-parent-"),
      );
      const descendantPidPath = join(directory, "descendant.pid");
      const kill = vi.spyOn(process, "kill");
      let descendantPid: number | undefined;
      try {
        const execution = runBoundedChild({
          executable: process.execPath,
          args: nodeEval(ignoringTreeSource(descendantPidPath)),
          env: { PATH: process.env.PATH ?? "" },
          timeoutMs: 150,
          maxStdoutBytes: 1_024,
          maxStderrBytes: 1_024,
          signal: new AbortController().signal,
        });
        void execution.catch(() => undefined);
        descendantPid = await waitForPid(descendantPidPath);

        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);

        await expect(execution).rejects.toMatchObject({ reason: "timeout" });
        await waitForProcessExit(descendantPid);
        expect(negativePidSignals(kill)).toEqual([]);
      } finally {
        forceKill(descendantPid);
        kill.mockRestore();
        await rm(directory, { force: true, recursive: true });
      }
    });

    test("cleans five concurrent cancelled groups without parent group signals", async () => {
      const kill = vi.spyOn(process, "kill");
      const run = async (index: number): Promise<void> => {
        const directory = await mkdtemp(
          join(tmpdir(), `cq-supervisor-concurrent-${String(index)}-`),
        );
        const descendantPidPath = join(directory, "descendant.pid");
        const controller = new AbortController();
        let descendantPid: number | undefined;
        try {
          const execution = runBoundedChild({
            executable: process.execPath,
            args: nodeEval(ignoringTreeSource(descendantPidPath)),
            env: { PATH: process.env.PATH ?? "" },
            timeoutMs: 2_000,
            maxStdoutBytes: 1_024,
            maxStderrBytes: 1_024,
            signal: controller.signal,
          });
          void execution.catch(() => undefined);
          descendantPid = await waitForPid(descendantPidPath);
          controller.abort();
          await expect(execution).rejects.toMatchObject({ reason: "aborted" });
          await waitForProcessExit(descendantPid);
        } finally {
          forceKill(descendantPid);
          await rm(directory, { force: true, recursive: true });
        }
      };
      try {
        await Promise.all(Array.from({ length: 5 }, (_, index) => run(index)));
        expect(negativePidSignals(kill)).toEqual([]);
      } finally {
        kill.mockRestore();
      }
    });
  },
);
