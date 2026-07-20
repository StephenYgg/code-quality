import {
  hooksStatus,
  installHooks,
  uninstallHooks,
  type HookMode,
  type HookPreset,
} from "../hooks/manager.js";
import {
  resolveHookMode,
  resolveHookPreset,
  type HookPhase,
} from "../hooks/presets.js";
import { runManagedHook } from "../hooks/run.js";

export async function runHooksInstallCommand(options: {
  readonly repository?: string;
  readonly mode: HookMode;
  readonly preset?: HookPreset;
  readonly confirm?: boolean;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  return installHooks({
    repository: options.repository ?? ".",
    mode: options.mode,
    ...(options.preset === undefined ? {} : { preset: options.preset }),
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  });
}

export async function runHooksUninstallCommand(options: {
  readonly repository?: string;
  readonly confirm?: boolean;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  return uninstallHooks({
    repository: options.repository ?? ".",
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  });
}

export async function runHooksStatusCommand(options: {
  readonly repository?: string;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  return hooksStatus({ repository: options.repository ?? "." });
}

export async function runHooksRunCommand(options: {
  readonly phase: string;
  readonly mode?: string;
  readonly preset?: string;
  readonly repository?: string;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  if (options.phase !== "pre-commit" && options.phase !== "pre-push") {
    return {
      exitCode: 2,
      output: "Hook phase must be pre-commit or pre-push\n",
    };
  }
  const phase: HookPhase = options.phase;
  return runManagedHook({
    phase,
    mode: resolveHookMode(options.mode),
    preset: resolveHookPreset(options.preset),
    ...(options.repository === undefined
      ? {}
      : { repository: options.repository }),
  });
}
