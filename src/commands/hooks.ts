import {
  hooksStatus,
  installHooks,
  uninstallHooks,
  type HookMode,
  type HookPreset,
} from "../hooks/manager.js";

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
