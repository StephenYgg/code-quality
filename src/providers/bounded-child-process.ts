import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import {
  PROCESS_SUPERVISOR_CONTROL_BYTES,
  PROCESS_SUPERVISOR_SOURCE,
} from "./process-supervisor.js";

type BoundedChild = ChildProcessByStdio<Writable, Readable, Readable>;
type SupervisorStdio = readonly [
  Writable,
  Readable,
  Readable,
  null,
  Readable | null | undefined,
  Writable | null | undefined,
];
type SupervisorState =
  "waiting_ready" | "ready" | "running" | "result_received";

export type BoundedChildFailureReason =
  | "aborted"
  | "timeout"
  | "stdout_limit"
  | "stderr_limit"
  | "combined_limit"
  | "extra_output_limit"
  | "supervisor"
  | "unsupported_platform"
  | "spawn"
  | "stdin";

export class BoundedChildError extends Error {
  constructor(readonly reason: BoundedChildFailureReason) {
    super(`Bounded child process failed: ${reason}`);
    this.name = "BoundedChildError";
  }
}

export interface BoundedChildControl {
  readonly active: () => boolean;
  readonly fail: (error: unknown) => void;
}

export interface BoundedChildResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly extraOutput: Buffer;
  readonly exitCode: number | null;
}

export interface BoundedExtraOutput {
  readonly childFd: number;
  readonly stream: Readable;
  readonly maxBytes: number;
}

interface BoundedChildOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxCombinedBytes?: number;
  readonly extraOutput?: BoundedExtraOutput;
  readonly signal: AbortSignal;
  readonly supervisorSource?: string;
  readonly startMonitor?: (control: BoundedChildControl) => () => void;
}

class BoundedChildExecution {
  private child: BoundedChild | undefined;
  private readonly stdout: Buffer[] = [];
  private readonly stderr: Buffer[] = [];
  private readonly extraOutput: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private combinedBytes = 0;
  private extraOutputBytes = 0;
  private extraOutputStream: Readable | undefined;
  private supervisorOutputStream: Readable | undefined;
  private supervisorInputStream: Writable | undefined;
  private supervisorOutput = Buffer.alloc(0);
  private supervisorOutputBytes = 0;
  private providerExitCode: number | null = null;
  private supervisorState: SupervisorState = "waiting_ready";
  private closing = false;
  private settled = false;
  private terminal: unknown;
  private readonly deadline: number;
  private timeout: NodeJS.Timeout | undefined;
  private stopMonitor: () => void = () => undefined;

  constructor(
    private readonly options: BoundedChildOptions,
    private readonly resolve: (result: BoundedChildResult) => void,
    private readonly reject: (error: Error) => void,
  ) {
    this.deadline = Date.now() + options.timeoutMs;
  }

  start(): void {
    let child: BoundedChild;
    try {
      child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          this.options.supervisorSource ?? PROCESS_SUPERVISOR_SOURCE,
          "--",
          this.options.extraOutput === undefined ? "0" : "1",
          String(this.deadline),
          this.options.executable,
          ...this.options.args,
        ],
        {
          ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
          env: this.options.env,
          shell: false,
          stdio: [
            "pipe",
            "pipe",
            "pipe",
            this.options.extraOutput?.childFd ?? "ignore",
            "pipe",
            "pipe",
          ],
          detached: process.platform !== "win32",
          windowsHide: true,
        },
      ) as BoundedChild;
      this.child = child;
    } catch {
      this.reject(new BoundedChildError("spawn"));
      return;
    }
    this.attachChildHandlers(child);
    this.attachSupervisorHandlers(child);
    this.attachExtraOutput();
    this.timeout = setTimeout(
      () => {
        this.fail(new BoundedChildError("timeout"));
      },
      Math.max(this.deadline - Date.now(), 0),
    );
    this.timeout.unref();
    this.options.signal.addEventListener("abort", this.onAbort, { once: true });
    if (this.options.signal.aborted) this.onAbort();
  }

  private readonly onAbort = () => {
    this.fail(new BoundedChildError("aborted"));
  };

  private active(): boolean {
    return !this.settled && this.terminal === undefined;
  }

  private startExternalMonitor(): void {
    if (!this.active() || this.options.startMonitor === undefined) return;
    try {
      const stopMonitor = this.options.startMonitor({
        active: () => this.active(),
        fail: (error) => {
          this.fail(error);
        },
      });
      if (this.active()) this.stopMonitor = stopMonitor;
      else stopMonitor();
    } catch (error) {
      this.fail(error);
    }
  }

  private attachChildHandlers(child: BoundedChild): void {
    child.stdout.on("data", (chunk: Buffer) => {
      this.collect(chunk, "stdout");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.collect(chunk, "stderr");
    });
    child.once("error", () => {
      this.fail(new BoundedChildError("spawn"));
    });
    child.once("close", (exitCode) => {
      void this.close(exitCode);
    });
    child.stdin.once("error", () => {
      this.fail(new BoundedChildError("stdin"));
    });
  }

  private attachExtraOutput(): void {
    if (this.options.extraOutput === undefined) return;
    this.extraOutputStream = this.options.extraOutput.stream;
    this.extraOutputStream.on("data", (chunk: Buffer) => {
      this.collectExtraOutput(chunk);
    });
    this.extraOutputStream.once("error", () => {
      this.fail(new BoundedChildError("spawn"));
    });
  }

  private attachSupervisorHandlers(child: BoundedChild): void {
    const stdio = child.stdio as unknown as SupervisorStdio;
    const output = stdio[4];
    const input = stdio[5];
    if (
      output === null ||
      output === undefined ||
      input === null ||
      input === undefined
    ) {
      this.fail(new BoundedChildError("supervisor"));
      return;
    }
    this.supervisorOutputStream = output;
    this.supervisorInputStream = input;
    output.on("data", (chunk: Buffer) => {
      this.collectSupervisorOutput(chunk);
    });
    output.once("error", () => {
      this.fail(new BoundedChildError("supervisor"));
    });
    output.once("end", () => {
      if (this.active() && this.supervisorOutput.length > 0) {
        this.fail(new BoundedChildError("supervisor"));
      }
    });
    input.once("error", () => {
      if (this.supervisorState !== "result_received") {
        this.fail(new BoundedChildError("supervisor"));
      }
    });
  }

  private collectSupervisorOutput(chunk: Buffer): void {
    if (!this.active()) return;
    if (
      chunk.length >
      PROCESS_SUPERVISOR_CONTROL_BYTES - this.supervisorOutputBytes
    ) {
      this.fail(new BoundedChildError("supervisor"));
      return;
    }
    this.supervisorOutputBytes += chunk.length;
    this.supervisorOutput = Buffer.concat(
      [this.supervisorOutput, chunk],
      this.supervisorOutput.length + chunk.length,
    );
    while (this.active()) {
      const newline = this.supervisorOutput.indexOf(0x0a);
      if (newline === -1) return;
      const message = this.supervisorOutput
        .subarray(0, newline)
        .toString("utf8");
      this.supervisorOutput = this.supervisorOutput.subarray(newline + 1);
      if (message.length === 0) {
        this.fail(new BoundedChildError("supervisor"));
        return;
      }
      this.acceptSupervisorFrame(message);
    }
  }

  private acceptSupervisorFrame(message: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(message) as unknown;
    } catch {
      this.fail(new BoundedChildError("supervisor"));
      return;
    }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      this.fail(new BoundedChildError("supervisor"));
      return;
    }
    const record = frame as Record<string, unknown>;
    if (record.kind === "ready") {
      if (
        this.supervisorState !== "waiting_ready" ||
        Object.keys(record).length !== 1
      ) {
        this.fail(new BoundedChildError("supervisor"));
        return;
      }
      this.supervisorState = "ready";
      this.startExternalMonitor();
      if (!this.active()) return;
      if (this.options.signal.aborted) {
        this.fail(new BoundedChildError("aborted"));
        return;
      }
      if (Date.now() >= this.deadline) {
        this.fail(new BoundedChildError("timeout"));
        return;
      }
      if (!this.writeSupervisorFrame("start")) {
        this.fail(new BoundedChildError("supervisor"));
        return;
      }
      this.supervisorState = "running";
      this.child?.stdin.end(this.options.stdin ?? "", "utf8");
      return;
    }
    const exitCode = record.exitCode;
    if (
      this.supervisorState !== "running" ||
      record.kind !== "result" ||
      (record.result !== "exit" && record.result !== "spawn_error") ||
      Object.keys(record).length !== 3 ||
      (exitCode !== null &&
        (typeof exitCode !== "number" ||
          !Number.isSafeInteger(exitCode) ||
          exitCode < 0 ||
          exitCode > 255))
    ) {
      this.fail(new BoundedChildError("supervisor"));
      return;
    }
    this.supervisorState = "result_received";
    this.providerExitCode = exitCode;
    if (record.result === "spawn_error") {
      this.terminal = new BoundedChildError("spawn");
    }
    if (!this.endSupervisorControl("ack") && this.terminal === undefined) {
      this.terminal = new BoundedChildError("supervisor");
    }
  }

  private writeSupervisorFrame(kind: "start"): boolean {
    const input = this.supervisorInputStream;
    if (input === undefined || input.destroyed || input.writableEnded)
      return false;
    try {
      input.write(`${JSON.stringify({ kind })}\n`, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  private endSupervisorControl(kind: "ack" | "cancel"): boolean {
    const input = this.supervisorInputStream;
    if (input === undefined || input.destroyed || input.writableEnded)
      return false;
    try {
      input.end(`${JSON.stringify({ kind })}\n`, "utf8");
      return true;
    } catch {
      input.destroy();
      return false;
    }
  }

  private collect(chunk: Buffer, stream: "stdout" | "stderr"): void {
    if (!this.active()) return;
    this.combinedBytes += chunk.length;
    if (
      this.options.maxCombinedBytes !== undefined &&
      this.combinedBytes > this.options.maxCombinedBytes
    ) {
      this.fail(new BoundedChildError("combined_limit"));
      return;
    }
    if (stream === "stdout") {
      this.stdoutBytes += chunk.length;
      if (this.stdoutBytes > this.options.maxStdoutBytes) {
        this.fail(new BoundedChildError("stdout_limit"));
        return;
      }
      this.stdout.push(Buffer.from(chunk));
      return;
    }
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > this.options.maxStderrBytes) {
      this.fail(new BoundedChildError("stderr_limit"));
      return;
    }
    this.stderr.push(Buffer.from(chunk));
  }

  private collectExtraOutput(chunk: Buffer): void {
    if (!this.active()) return;
    const limit = this.options.extraOutput?.maxBytes;
    if (limit === undefined) return;
    if (chunk.length > limit - this.extraOutputBytes) {
      this.fail(new BoundedChildError("extra_output_limit"));
      return;
    }
    this.extraOutputBytes += chunk.length;
    this.extraOutput.push(Buffer.from(chunk));
  }

  private fail(error: unknown): void {
    if (!this.active() || this.child === undefined) return;
    this.terminal = error;
    this.stopWaiting();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.extraOutputStream?.destroy();
    this.endSupervisorControl("cancel");
  }

  private stopWaiting(): void {
    if (this.timeout !== undefined) clearTimeout(this.timeout);
    this.stopMonitor();
    this.options.signal.removeEventListener("abort", this.onAbort);
  }

  private async close(exitCode: number | null): Promise<void> {
    if (this.settled || this.closing) return;
    this.closing = true;
    if (
      this.supervisorState !== "result_received" &&
      this.terminal === undefined
    ) {
      this.terminal =
        Date.now() >= this.deadline
          ? new BoundedChildError("timeout")
          : new BoundedChildError("supervisor");
    }
    await this.waitForExtraOutputEnd();
    this.settled = true;
    this.stopWaiting();
    if (this.terminal !== undefined) {
      this.reject(
        this.terminal instanceof Error
          ? this.terminal
          : new Error("Bounded child process failed"),
      );
      return;
    }
    this.resolve({
      stdout: Buffer.concat(this.stdout, this.stdoutBytes),
      stderr: Buffer.concat(this.stderr, this.stderrBytes),
      extraOutput: Buffer.concat(this.extraOutput, this.extraOutputBytes),
      exitCode:
        this.supervisorState === "result_received"
          ? this.providerExitCode
          : exitCode,
    });
  }

  private waitForExtraOutputEnd(): Promise<void> {
    const stream = this.extraOutputStream;
    if (
      stream === undefined ||
      stream.readableEnded ||
      stream.destroyed ||
      this.terminal !== undefined
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = (): void => {
        stream.removeListener("end", finish);
        stream.removeListener("close", finish);
        resolve();
      };
      stream.once("end", finish);
      stream.once("close", finish);
    });
  }
}

export async function runBoundedChild(
  options: BoundedChildOptions,
): Promise<BoundedChildResult> {
  if (process.platform === "win32") {
    throw new BoundedChildError("unsupported_platform");
  }
  if (options.signal.aborted) throw new BoundedChildError("aborted");
  if (options.timeoutMs <= 0) throw new BoundedChildError("timeout");
  return new Promise((resolve, reject) => {
    new BoundedChildExecution(options, resolve, reject).start();
  });
}
