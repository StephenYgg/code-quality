import { spawn, type ChildProcessByStdio } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { describe, expect, test } from "vitest";

import {
  PROCESS_SUPERVISOR_CONTROL_BYTES,
  PROCESS_SUPERVISOR_SOURCE,
} from "../../../src/providers/process-supervisor.js";

type HarnessChild = ChildProcessByStdio<null, null, null>;
type HarnessStdio = readonly [null, null, null, null, Readable, Writable];

interface SupervisorHarness {
  readonly child: HarnessChild;
  readonly output: Readable;
  readonly input: Writable;
  readonly close: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
}

function providerSource(markerPath: string, hang = false): string {
  return String.raw`
import { writeFileSync, writeSync } from "node:fs";
try {
  writeSync(4, JSON.stringify({ kind: "provider_injected" }) + "\n", null, "utf8");
} catch {}
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
  pid: process.pid,
}), "utf8");
${hang ? 'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 60_000);' : ""}
`;
}

function spawnSupervisor(
  markerPath: string,
  hang = false,
  deadline = Date.now() + 2_000,
  supervisorSource = PROCESS_SUPERVISOR_SOURCE,
): SupervisorHarness {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      supervisorSource,
      "--",
      "0",
      String(deadline),
      process.execPath,
      "--input-type=module",
      "-e",
      providerSource(markerPath, hang),
    ],
    {
      detached: true,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "ignore", "ignore", "ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  ) as HarnessChild;
  const stdio = child.stdio as unknown as HarnessStdio;
  return {
    child,
    output: stdio[4],
    input: stdio[5],
    close: new Promise((resolve) => {
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    }),
  };
}

function deadlineAfterReadySupervisorSource(): string {
  const declaration = "const absoluteDeadline = Number(deadlineText);";
  const controlledClock = String.raw`
const absoluteDeadline = Number(deadlineText);
const initialNow = Date.now();
let clockReads = 0;
Date.now = () => (++clockReads <= 2 ? initialNow : absoluteDeadline + 1);
`;
  const source = PROCESS_SUPERVISOR_SOURCE.replace(
    declaration,
    controlledClock.trim(),
  );
  if (source === PROCESS_SUPERVISOR_SOURCE) {
    throw new Error("supervisor deadline declaration was not instrumented");
  }
  return source;
}

function createFrameReader(stream: Readable): () => Promise<string> {
  const frames: string[] = [];
  let pending = Buffer.alloc(0);
  let waiter:
    | {
        readonly resolve: (frame: string) => void;
        readonly reject: (error: Error) => void;
        readonly timeout: NodeJS.Timeout;
      }
    | undefined;
  const flush = (): void => {
    if (waiter === undefined || frames.length === 0) return;
    const current = waiter;
    waiter = undefined;
    clearTimeout(current.timeout);
    const frame = frames.shift();
    if (frame !== undefined) current.resolve(frame);
  };
  stream.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk], pending.length + chunk.length);
    if (pending.length > PROCESS_SUPERVISOR_CONTROL_BYTES) {
      waiter?.reject(new Error("supervisor output exceeded its test bound"));
      return;
    }
    let newline = pending.indexOf(0x0a);
    while (newline !== -1) {
      frames.push(pending.subarray(0, newline).toString("utf8"));
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
    flush();
  });
  stream.once("error", (error) => {
    waiter?.reject(error);
  });
  return () => {
    const frame = frames.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiter = undefined;
        reject(new Error("supervisor did not emit a control frame"));
      }, 2_000);
      waiter = { resolve, reject, timeout };
    });
  };
}

async function cleanupHarness(harness: SupervisorHarness): Promise<void> {
  const pid = harness.child.pid;
  if (pid === undefined || harness.child.exitCode !== null) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    harness.child.kill("SIGKILL");
  }
  await harness.close;
}

describe.skipIf(process.platform === "win32")(
  "process supervisor control protocol",
  () => {
    test("accepts partial START and ACK frames without passing control fds", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "cq-supervisor-protocol-"),
      );
      const markerPath = join(directory, "provider.json");
      const harness = spawnSupervisor(markerPath);
      const readFrame = createFrameReader(harness.output);
      try {
        expect(JSON.parse(await readFrame())).toEqual({ kind: "ready" });
        harness.input.write('{"kind":"sta');
        await new Promise((resolve) => setTimeout(resolve, 10));
        harness.input.write('rt"}\n');

        expect(JSON.parse(await readFrame())).toEqual({
          kind: "result",
          result: "exit",
          exitCode: 0,
        });
        harness.input.write('{"kind":"a');
        await new Promise((resolve) => setTimeout(resolve, 10));
        harness.input.end('ck"}\n');

        await expect(harness.close).resolves.toMatchObject({
          code: null,
          signal: "SIGKILL",
        });
        const marker: unknown = JSON.parse(await readFile(markerPath, "utf8"));
        if (
          marker === null ||
          typeof marker !== "object" ||
          Array.isArray(marker)
        ) {
          throw new Error("provider marker was not an object");
        }
        expect(typeof (marker as Record<string, unknown>).pid).toBe("number");
      } finally {
        await cleanupHarness(harness);
        await rm(directory, { force: true, recursive: true });
      }
    });

    test("fails closed on a partial malformed frame before START", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "cq-supervisor-malformed-"),
      );
      const markerPath = join(directory, "provider.json");
      const harness = spawnSupervisor(markerPath);
      const readFrame = createFrameReader(harness.output);
      try {
        expect(JSON.parse(await readFrame())).toEqual({ kind: "ready" });
        harness.input.end('{"kind":"start"');

        await expect(harness.close).resolves.toEqual({ code: 0, signal: null });
        await expect(access(markerPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await cleanupHarness(harness);
        await rm(directory, { force: true, recursive: true });
      }
    });

    test("fails closed on duplicate START and kills the owned group", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "cq-supervisor-duplicate-"),
      );
      const markerPath = join(directory, "provider.json");
      const harness = spawnSupervisor(markerPath, true);
      const readFrame = createFrameReader(harness.output);
      try {
        expect(JSON.parse(await readFrame())).toEqual({ kind: "ready" });
        harness.input.end('{"kind":"start"}\n{"kind":"start"}\n');

        await expect(harness.close).resolves.toMatchObject({
          code: null,
          signal: "SIGKILL",
        });
      } finally {
        await cleanupHarness(harness);
        await rm(directory, { force: true, recursive: true });
      }
    });

    test("does not spawn when START is processed after the deadline", async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "cq-supervisor-late-start-"),
      );
      const markerPath = join(directory, "provider.json");
      const deadline = Date.now() + 2_000;
      const harness = spawnSupervisor(
        markerPath,
        true,
        deadline,
        deadlineAfterReadySupervisorSource(),
      );
      const readFrame = createFrameReader(harness.output);
      try {
        expect(JSON.parse(await readFrame())).toEqual({ kind: "ready" });
        harness.input.end('{"kind":"start"}\n');

        await expect(harness.close).resolves.toEqual({ code: 0, signal: null });
        await expect(access(markerPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await cleanupHarness(harness);
        await rm(directory, { force: true, recursive: true });
      }
    });
  },
);
