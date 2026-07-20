export const PROCESS_SUPERVISOR_CONTROL_BYTES = 256;

export const PROCESS_SUPERVISOR_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { createReadStream, writeSync } from "node:fs";

const [extraOutputFlag, deadlineText, executable, ...args] = process.argv.slice(1);
const CONTROL_BYTES = 256;
const FORCE_KILL_GRACE_MS = 100;
const RESULT_ACK_TIMEOUT_MS = 1_000;
const MAX_TIMER_MS = 2_147_483_647;
const absoluteDeadline = Number(deadlineText);
let state = "initializing";
let cleanupStarted = false;
let terminationStarted = false;
let controlBytes = 0;
let outputBytes = 0;
let controlBuffer = Buffer.alloc(0);

function forceKillOwnedGroup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  state = "done";
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.kill(process.pid, "SIGKILL");
  }
}

function finishBeforeStart() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  state = "done";
  process.exit(0);
}

function cancelOwnedWork() {
  if (cleanupStarted || state === "done" || state === "terminating") return;
  if (state === "initializing" || state === "waiting_start") {
    finishBeforeStart();
    return;
  }
  if (state === "waiting_ack") {
    forceKillOwnedGroup();
    return;
  }
  if (state !== "running") {
    forceKillOwnedGroup();
    return;
  }
  if (terminationStarted) return;
  terminationStarted = true;
  state = "terminating";
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {
    forceKillOwnedGroup();
    return;
  }
  setTimeout(forceKillOwnedGroup, FORCE_KILL_GRACE_MS);
}

process.on("SIGTERM", cancelOwnedWork);

function sendFrame(frame) {
  const message = JSON.stringify(frame) + "\n";
  const bytes = Buffer.byteLength(message, "utf8");
  if (bytes > CONTROL_BYTES - outputBytes) {
    cancelOwnedWork();
    return false;
  }
  outputBytes += bytes;
  try {
    writeSync(4, message, null, "utf8");
    return true;
  } catch {
    cancelOwnedWork();
    return false;
  }
}

function reportResult(result, exitCode) {
  if (state !== "running") return;
  state = "waiting_ack";
  if (!sendFrame({ kind: "result", result, exitCode })) return;
  setTimeout(forceKillOwnedGroup, RESULT_ACK_TIMEOUT_MS);
}

function startProvider() {
  if (state !== "waiting_start" || executable === undefined) {
    cancelOwnedWork();
    return;
  }
  if (Date.now() >= absoluteDeadline) {
    cancelOwnedWork();
    return;
  }
  state = "running";
  let child;
  try {
    child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio:
        extraOutputFlag === "1"
          ? ["inherit", "inherit", "inherit", "inherit", "ignore", "ignore"]
          : ["inherit", "inherit", "inherit", "ignore", "ignore", "ignore"],
      windowsHide: true,
    });
  } catch {
    reportResult("spawn_error", null);
    return;
  }
  child.once("error", () => reportResult("spawn_error", null));
  child.once("exit", (exitCode) => reportResult("exit", exitCode));
}

function exactFrame(value, kind) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.kind === kind &&
    Object.keys(value).length === 1
  );
}

function acceptControlFrame(message) {
  let frame;
  try {
    frame = JSON.parse(message);
  } catch {
    cancelOwnedWork();
    return;
  }
  if (exactFrame(frame, "cancel")) {
    cancelOwnedWork();
    return;
  }
  if (state === "waiting_start" && exactFrame(frame, "start")) {
    startProvider();
    return;
  }
  if (state === "waiting_ack" && exactFrame(frame, "ack")) {
    forceKillOwnedGroup();
    return;
  }
  cancelOwnedWork();
}

function collectControl(chunk) {
  if (cleanupStarted) return;
  if (chunk.length > CONTROL_BYTES - controlBytes) {
    cancelOwnedWork();
    return;
  }
  controlBytes += chunk.length;
  controlBuffer = Buffer.concat([controlBuffer, chunk], controlBuffer.length + chunk.length);
  while (!cleanupStarted) {
    const newline = controlBuffer.indexOf(0x0a);
    if (newline === -1) return;
    const frame = controlBuffer.subarray(0, newline).toString("utf8");
    controlBuffer = controlBuffer.subarray(newline + 1);
    if (frame.length === 0) {
      cancelOwnedWork();
      return;
    }
    acceptControlFrame(frame);
  }
}

function closeControl() {
  if (controlBuffer.length > 0) {
    cancelOwnedWork();
    return;
  }
  cancelOwnedWork();
}

function main() {
  if (
    !Number.isSafeInteger(absoluteDeadline) ||
    absoluteDeadline <= Date.now() ||
    executable === undefined
  ) {
    finishBeforeStart();
    return;
  }
  let control;
  try {
    control = createReadStream("/dev/null", { fd: 5, autoClose: false });
  } catch {
    finishBeforeStart();
    return;
  }
  control.on("data", collectControl);
  control.once("end", closeControl);
  control.once("error", cancelOwnedWork);
  const remaining = Math.min(absoluteDeadline - Date.now(), MAX_TIMER_MS);
  setTimeout(cancelOwnedWork, Math.max(remaining, 0));
  state = "waiting_start";
  sendFrame({ kind: "ready" });
}

main();
`;
