import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const MANAGED_BEGIN = "# >>> code-quality managed hook >>>";
const MANAGED_END = "# <<< code-quality managed hook <<<";

export type HookMode = "warn" | "block";
export type HookPreset = "balanced" | "strict";

function hookBody(name: "pre-commit" | "pre-push", mode: HookMode): string {
  const command =
    name === "pre-commit"
      ? "cq review --staged --format terminal"
      : "cq review --worktree --format terminal";
  return [
    "#!/bin/sh",
    MANAGED_BEGIN,
    "# Installed by code-quality. Local hooks are bypassable and not server enforcement.",
    `CQ_HOOK_MODE=${mode}`,
    `if ! command -v cq >/dev/null 2>&1; then`,
    `  echo "code-quality: cq not found; skipping ${name}" >&2`,
    `  exit 0`,
    `fi`,
    `output="$(${command} 2>&1)"`,
    `status=$?`,
    `echo "$output"`,
    `if [ "$CQ_HOOK_MODE" = "warn" ]; then`,
    `  exit 0`,
    `fi`,
    `exit $status`,
    MANAGED_END,
    "",
  ].join("\n");
}

export async function installHooks(options: {
  readonly repository: string;
  readonly mode: HookMode;
  readonly preset?: HookPreset;
  readonly confirm?: boolean;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const gitDir = join(options.repository, ".git");
  const hooksDir = join(gitDir, "hooks");
  try {
    await access(gitDir);
  } catch {
    return { exitCode: 2, output: "Not a git repository\n" };
  }
  if (options.confirm !== true) {
    return {
      exitCode: 0,
      output: [
        "Hooks install plan:",
        `mode: ${options.mode}`,
        `preset: ${options.preset ?? "balanced"}`,
        "files: pre-commit, pre-push",
        "Re-run with --confirm to apply.",
        "",
      ].join("\n"),
    };
  }
  await mkdir(hooksDir, { recursive: true });
  for (const name of ["pre-commit", "pre-push"] as const) {
    const path = join(hooksDir, name);
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = "";
    }
    if (
      existing.length > 0 &&
      !existing.includes(MANAGED_BEGIN) &&
      !existing.includes("code-quality managed hook")
    ) {
      return {
        exitCode: 2,
        output: [
          `Refusing to overwrite unrecognized ${name} hook.`,
          "Append this snippet manually or remove the unknown hook first:",
          hookBody(name, options.mode),
        ].join("\n"),
      };
    }
    const temporary = `${path}.tmp`;
    await writeFile(temporary, hookBody(name, options.mode), {
      mode: 0o755,
      flag: "w",
    });
    await chmod(temporary, 0o755);
    await rename(temporary, path);
  }
  return {
    exitCode: 0,
    output: `Installed managed hooks in ${hooksDir}\n`,
  };
}

export async function uninstallHooks(options: {
  readonly repository: string;
  readonly confirm?: boolean;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  if (options.confirm !== true) {
    return {
      exitCode: 0,
      output:
        "Hooks uninstall plan: remove managed pre-commit/pre-push. Re-run with --confirm.\n",
    };
  }
  const hooksDir = join(options.repository, ".git", "hooks");
  for (const name of ["pre-commit", "pre-push"]) {
    const path = join(hooksDir, name);
    try {
      const existing = await readFile(path, "utf8");
      if (existing.includes(MANAGED_BEGIN)) {
        await writeFile(path, "", { mode: 0o644 });
      }
    } catch {
      // missing is fine
    }
  }
  return { exitCode: 0, output: "Removed managed hook content\n" };
}

export async function hooksStatus(options: {
  readonly repository: string;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const hooksDir = join(options.repository, ".git", "hooks");
  const lines: string[] = [];
  for (const name of ["pre-commit", "pre-push"]) {
    const path = join(hooksDir, name);
    try {
      const existing = await readFile(path, "utf8");
      lines.push(
        `${name}: ${existing.includes(MANAGED_BEGIN) ? "managed" : "unrecognized"}`,
      );
    } catch {
      lines.push(`${name}: missing`);
    }
  }
  return { exitCode: 0, output: `${lines.join("\n")}\n` };
}
