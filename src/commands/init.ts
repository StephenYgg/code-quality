import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface InitCommandOptions {
  readonly repository?: string;
  readonly confirm?: boolean;
}

const DEFAULT_PROFILE = `schemaVersion: 1
name: default
extends: builtin/default
`;

export async function runInitCommand(
  options: InitCommandOptions = {},
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const repository = options.repository ?? ".";
  const directory = join(repository, ".code-quality");
  const profilePath = join(directory, "profile.yaml");
  try {
    await access(profilePath);
    return {
      exitCode: 2,
      output: "Refusing to overwrite existing .code-quality/profile.yaml\n",
    };
  } catch {
    // does not exist
  }
  if (options.confirm !== true) {
    return {
      exitCode: 0,
      output: [
        "Init plan (read-only until --confirm):",
        `create: ${profilePath}`,
        "No AGENTS.md will be created or replaced.",
        "Re-run with --confirm to apply.",
        "",
      ].join("\n"),
    };
  }
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await writeFile(profilePath, DEFAULT_PROFILE, { flag: "wx", mode: 0o644 });
  return {
    exitCode: 0,
    output: `Created ${profilePath}\n`,
  };
}
