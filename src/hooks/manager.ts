import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { runGitCommand } from "../git/commands.js";
import {
  acquireLock,
  LockError,
  releaseLock,
  type LockHandle,
} from "../storage/locks.js";
import { HOOK_PRESETS, type HookMode, type HookPreset } from "./presets.js";

export type { HookMode, HookPreset } from "./presets.js";

const MANAGED_BEGIN = "# >>> code-quality managed hook >>>";
const MANAGED_END = "# <<< code-quality managed hook <<<";
const HOOK_NAMES = ["pre-commit", "pre-push"] as const;
const HOOK_LOCK_WAIT_MS = 3_000;
const MAX_HOOK_FILE_BYTES = 256 * 1024;

interface HookManagerIo {
  readonly renameFile?: (source: string, destination: string) => Promise<void>;
}

interface HookState {
  readonly name: (typeof HOOK_NAMES)[number];
  readonly path: string;
  readonly body: string;
  readonly existed: boolean;
  readonly updatedBody: string;
  readonly stagedPath: string;
}

function managedBlock(
  name: (typeof HOOK_NAMES)[number],
  mode: HookMode,
  preset: HookPreset,
): string {
  return [
    MANAGED_BEGIN,
    "# Installed by code-quality. Local hooks are bypassable and not server enforcement.",
    `CQ_HOOK_MODE=${mode}`,
    `CQ_HOOK_PRESET=${preset}`,
    `CQ_HOOK_PHASE=${name}`,
    `CQ_HOOK_FAIL_OPEN=${HOOK_PRESETS[preset].failOpenOnIncomplete ? "1" : "0"}`,
    `if ! command -v cq >/dev/null 2>&1; then`,
    `  echo "code-quality: cq not found; fail-open skip for ${name}" >&2`,
    `  exit 0`,
    `fi`,
    `cq hooks run ${name} --mode "$CQ_HOOK_MODE" --preset "$CQ_HOOK_PRESET"`,
    `status=$?`,
    `if [ "$CQ_HOOK_MODE" = "warn" ]; then`,
    `  exit 0`,
    `fi`,
    `exit $status`,
    MANAGED_END,
  ].join("\n");
}

function hookBody(
  name: (typeof HOOK_NAMES)[number],
  mode: HookMode,
  preset: HookPreset,
): string {
  return `#!/bin/sh\n${managedBlock(name, mode, preset)}\n`;
}

function managedRange(
  body: string,
): { readonly start: number; readonly end: number } | undefined {
  const start = body.indexOf(MANAGED_BEGIN);
  const endStart = body.indexOf(MANAGED_END);
  if (
    start < 0 ||
    endStart < start ||
    start !== body.lastIndexOf(MANAGED_BEGIN) ||
    endStart !== body.lastIndexOf(MANAGED_END)
  ) {
    return undefined;
  }
  let end = endStart + MANAGED_END.length;
  if (body[end] === "\n") end += 1;
  return { start, end };
}

function updateManagedBody(
  existing: string,
  name: (typeof HOOK_NAMES)[number],
  mode: HookMode,
  preset: HookPreset,
): string | undefined {
  if (existing.length === 0)
    return checkedHookBody(hookBody(name, mode, preset));
  const range = managedRange(existing);
  if (range === undefined) return undefined;
  return checkedHookBody(
    `${existing.slice(0, range.start)}${managedBlock(name, mode, preset)}\n${existing.slice(range.end)}`,
  );
}

function removeManagedBody(existing: string): string | undefined {
  const range = managedRange(existing);
  if (range === undefined) return undefined;
  return `${existing.slice(0, range.start)}${existing.slice(range.end)}`;
}

async function readHooksPath(repository: string): Promise<string | undefined> {
  try {
    const result = await runGitCommand({
      repository,
      args: ["config", "--get", "core.hooksPath"],
      hooksPathQuery: true,
      timeoutMs: 5_000,
      maximumStdoutBytes: 4_096,
      maximumStderrBytes: 4_096,
    });
    const value = result.stdout.toString("utf8").trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

async function resolveHooksDirectory(
  repository: string,
): Promise<string | undefined> {
  try {
    const result = await runGitCommand({
      repository,
      args: ["rev-parse", "--git-path", "hooks"],
      hooksPathQuery: true,
      timeoutMs: 5_000,
      maximumStdoutBytes: 4_096,
      maximumStderrBytes: 4_096,
    });
    const path = result.stdout.toString("utf8").trim();
    if (path.length === 0 || path.includes("\0")) return undefined;
    return isAbsolute(path) ? path : resolve(repository, path);
  } catch {
    return undefined;
  }
}

function hookLockKey(directory: string): string {
  return createHash("sha256")
    .update("cq-hook-install:v1\0")
    .update(directory)
    .digest("hex");
}

async function waitForHookLock(directory: string): Promise<LockHandle> {
  const deadline = Date.now() + HOOK_LOCK_WAIT_MS;
  for (;;) {
    try {
      return await acquireLock(hookLockKey(directory), {
        ttlMs: 30_000,
      });
    } catch (error) {
      if (!(error instanceof LockError) || error.code !== "LOCK_BUSY") {
        throw error;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Timed out waiting for hook installer");
    await delay(Math.min(10 + Math.floor(Math.random() * 15), remaining));
  }
}

async function readHook(path: string): Promise<{
  readonly body: string;
  readonly existed: boolean;
}> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isMissing(error)) return { body: "", existed: false };
    throw error;
  }
  try {
    const content = Buffer.alloc(MAX_HOOK_FILE_BYTES + 1);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_HOOK_FILE_BYTES) {
      throw new Error(
        `Hook file exceeds the ${MAX_HOOK_FILE_BYTES.toString()}-byte limit`,
      );
    }
    return {
      body: content.subarray(0, offset).toString("utf8"),
      existed: true,
    };
  } finally {
    await handle.close();
  }
}

async function stageHooks(options: {
  readonly directory: string;
  readonly mode: HookMode;
  readonly preset: HookPreset;
}): Promise<readonly HookState[] | undefined> {
  const states: HookState[] = [];
  const stagedPaths: string[] = [];
  let completed = false;
  try {
    for (const name of HOOK_NAMES) {
      const path = resolve(options.directory, name);
      const current = await readHook(path);
      const updatedBody = updateManagedBody(
        current.body,
        name,
        options.mode,
        options.preset,
      );
      if (updatedBody === undefined) return undefined;
      const stagedPath = resolve(
        options.directory,
        `.${name}.staged-${randomUUID()}`,
      );
      stagedPaths.push(stagedPath);
      await writeFile(stagedPath, updatedBody, { flag: "wx", mode: 0o755 });
      await chmod(stagedPath, 0o755);
      states.push({ name, path, ...current, updatedBody, stagedPath });
    }
    completed = true;
    return Object.freeze(states);
  } finally {
    if (!completed) {
      await Promise.all(stagedPaths.map((path) => rm(path, { force: true })));
    }
  }
}

async function restoreHook(state: HookState): Promise<void> {
  if (!state.existed) {
    await rm(state.path, { force: true });
    return;
  }
  const rollbackPath = `${state.path}.rollback-${randomUUID()}`;
  await writeFile(rollbackPath, state.body, { flag: "wx", mode: 0o755 });
  await chmod(rollbackPath, 0o755);
  await rename(rollbackPath, state.path);
}

async function applyStagedHooks(
  states: readonly HookState[],
  io: HookManagerIo | undefined,
): Promise<boolean> {
  const renameFile = io?.renameFile ?? rename;
  const applied: HookState[] = [];
  try {
    for (const state of states) {
      await renameFile(state.stagedPath, state.path);
      applied.push(state);
    }
    return true;
  } catch {
    await Promise.all(applied.map(restoreHook));
    return false;
  } finally {
    await Promise.all(
      states.map((state) => rm(state.stagedPath, { force: true })),
    );
  }
}

export async function installHooks(options: {
  readonly repository: string;
  readonly mode: HookMode;
  readonly preset?: HookPreset;
  readonly confirm?: boolean;
  readonly io?: HookManagerIo;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const preset = options.preset ?? "balanced";
  const hooksDirectory = await resolveHooksDirectory(options.repository);
  if (hooksDirectory === undefined) {
    return { exitCode: 2, output: "Not a git repository\n" };
  }
  const configuredPath = await readHooksPath(options.repository);
  const hooksPathNote =
    configuredPath === undefined
      ? `core.hooksPath: default (${hooksDirectory})`
      : `core.hooksPath: ${configuredPath} (${hooksDirectory})`;
  if (options.confirm !== true) {
    return {
      exitCode: 0,
      output: [
        "Hooks install plan:",
        `mode: ${options.mode}`,
        `preset: ${preset}`,
        `failOpenOnIncomplete: ${HOOK_PRESETS[preset].failOpenOnIncomplete ? "yes" : "no"}`,
        hooksPathNote,
        "files: pre-commit, pre-push",
        "runtime: cq hooks run <phase> --mode ... --preset ...",
        "cacheKey: snapshot+policy+prompt+provider+model+preset",
        "Re-run with --confirm to apply.",
        "",
      ].join("\n"),
    };
  }

  await mkdir(hooksDirectory, { recursive: true, mode: 0o700 });
  let lock: LockHandle | undefined;
  try {
    lock = await waitForHookLock(hooksDirectory);
    const states = await stageHooks({
      directory: hooksDirectory,
      mode: options.mode,
      preset,
    });
    if (states === undefined) {
      return {
        exitCode: 2,
        output:
          "Refusing to overwrite an unrecognized or malformed hook. Add the managed snippet explicitly first.\n",
      };
    }
    if (!(await applyStagedHooks(states, options.io))) {
      return {
        exitCode: 2,
        output: "Hook installation failed; prior hook contents were restored\n",
      };
    }
    return {
      exitCode: 0,
      output: [
        `Installed managed hooks in ${hooksDirectory}`,
        `mode: ${options.mode}`,
        `preset: ${preset}`,
        hooksPathNote,
        "",
      ].join("\n"),
    };
  } catch (error) {
    return {
      exitCode: 2,
      output: `Hook installation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    };
  } finally {
    if (lock !== undefined) await releaseLock(lock);
  }
}

export async function uninstallHooks(options: {
  readonly repository: string;
  readonly confirm?: boolean;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  if (options.confirm !== true) {
    return {
      exitCode: 0,
      output:
        "Hooks uninstall plan: remove managed pre-commit/pre-push blocks. Re-run with --confirm.\n",
    };
  }
  const directory = await resolveHooksDirectory(options.repository);
  if (directory === undefined) {
    return { exitCode: 2, output: "Not a git repository\n" };
  }
  const lock = await waitForHookLock(directory);
  try {
    for (const name of HOOK_NAMES) {
      const path = resolve(directory, name);
      const current = await readHook(path);
      if (!current.existed) continue;
      const updated = removeManagedBody(current.body);
      if (updated === undefined) continue;
      const staged = `${path}.staged-${randomUUID()}`;
      await writeFile(staged, updated, { flag: "wx", mode: 0o755 });
      await chmod(staged, 0o755);
      await rename(staged, path);
    }
    return { exitCode: 0, output: "Removed managed hook content\n" };
  } finally {
    await releaseLock(lock);
  }
}

export async function hooksStatus(options: {
  readonly repository: string;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const directory = await resolveHooksDirectory(options.repository);
  if (directory === undefined) {
    return { exitCode: 2, output: "Not a git repository\n" };
  }
  const configuredPath = await readHooksPath(options.repository);
  const lines: string[] = [
    configuredPath === undefined
      ? `core.hooksPath: default (${directory})`
      : `core.hooksPath: ${configuredPath} (${directory})`,
    "cacheKey components: snapshot, policy, prompt bundle, provider, model, preset",
  ];
  for (const name of HOOK_NAMES) {
    const current = await readHook(resolve(directory, name));
    if (!current.existed) {
      lines.push(`${name}: missing`);
      continue;
    }
    if (managedRange(current.body) === undefined) {
      lines.push(`${name}: unrecognized`);
      continue;
    }
    const mode = parseManagedField(current.body, "CQ_HOOK_MODE") ?? "unknown";
    const preset =
      parseManagedField(current.body, "CQ_HOOK_PRESET") ?? "unknown";
    const failOpen =
      parseManagedField(current.body, "CQ_HOOK_FAIL_OPEN") ?? "unknown";
    lines.push(
      `${name}: managed mode=${mode} preset=${preset} failOpen=${failOpen}`,
    );
  }
  return { exitCode: 0, output: `${lines.join("\n")}\n` };
}

function parseManagedField(body: string, key: string): string | undefined {
  return new RegExp(`^${key}=(\\S+)`, "mu").exec(body)?.[1];
}

function checkedHookBody(body: string): string {
  if (Buffer.byteLength(body, "utf8") > MAX_HOOK_FILE_BYTES) {
    throw new Error(
      `Hook file exceeds the ${MAX_HOOK_FILE_BYTES.toString()}-byte limit`,
    );
  }
  return body;
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
