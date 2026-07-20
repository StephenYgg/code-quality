import {
  access,
  chmod,
  constants,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const MANAGED_BEGIN = "<!-- code-quality managed block begin -->";
export const MANAGED_END = "<!-- code-quality managed block end -->";

const DEFAULT_BLOCK = `${MANAGED_BEGIN}
## Code Quality CLI

Use the Agent-neutral \`cq\` CLI for deterministic validation and review
orchestration. Shared rules remain in \`AGENTS.md\`. Do not copy machine policy
JSON/YAML into Skills or prompts.

Common commands:

\`\`\`bash
cq validate
cq review --staged
cq review --repository --preflight
\`\`\`
${MANAGED_END}
`;

export class IntegrationError extends Error {
  constructor(
    readonly code:
      "INTEGRATION_PATH_INVALID" | "INTEGRATION_REFUSED" | "INTEGRATION_IO",
    message: string,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

function assertSafeTarget(root: string, target: string): string {
  if (!isAbsolute(root) || !isAbsolute(target)) {
    throw new IntegrationError(
      "INTEGRATION_PATH_INVALID",
      "Integration paths must be absolute",
    );
  }
  const relation = relative(root, target);
  if (
    relation.startsWith(`..${sep}`) ||
    relation === ".." ||
    isAbsolute(relation)
  ) {
    throw new IntegrationError(
      "INTEGRATION_PATH_INVALID",
      "Integration target escapes the configured root",
    );
  }
  return target;
}

export function planManagedBlockUpdate(
  existing: string,
  block: string = DEFAULT_BLOCK,
): {
  readonly next: string;
  readonly action: "create" | "update" | "unchanged";
} {
  const begin = existing.indexOf(MANAGED_BEGIN);
  const end = existing.indexOf(MANAGED_END);
  if (begin < 0 && end < 0) {
    const separator =
      existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    return {
      next: `${existing}${separator}${block}\n`,
      action: existing.length === 0 ? "create" : "update",
    };
  }
  if (begin < 0 || end < 0 || end < begin) {
    throw new IntegrationError(
      "INTEGRATION_REFUSED",
      "Existing file has a malformed managed block",
    );
  }
  const before = existing.slice(0, begin);
  const after = existing.slice(end + MANAGED_END.length);
  const next = `${before}${block}${after.startsWith("\n") ? after : `\n${after}`}`;
  return {
    next,
    action: next === existing ? "unchanged" : "update",
  };
}

export async function installManagedIntegration(options: {
  readonly root: string;
  readonly relativePath: string;
  readonly confirm?: boolean;
  readonly block?: string;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const target = assertSafeTarget(
    options.root,
    join(options.root, options.relativePath),
  );
  try {
    const meta = await lstat(target).catch(() => undefined);
    if (meta?.isSymbolicLink()) {
      return {
        exitCode: 2,
        output: `Refusing to modify symlink target: ${options.relativePath}\n`,
      };
    }
  } catch {
    // missing is fine
  }

  let existing = "";
  try {
    existing = await readFile(target, "utf8");
  } catch {
    existing = "";
  }
  let planned: ReturnType<typeof planManagedBlockUpdate>;
  try {
    planned = planManagedBlockUpdate(existing, options.block ?? DEFAULT_BLOCK);
  } catch (error) {
    return {
      exitCode: 2,
      output:
        error instanceof Error ? `${error.message}\n` : "Integration refused\n",
    };
  }
  if (options.confirm !== true) {
    return {
      exitCode: 0,
      output: [
        "Integration plan (read-only until --confirm):",
        `root: ${options.root}`,
        `path: ${options.relativePath}`,
        `action: ${planned.action}`,
        "Re-run with --confirm to apply.",
        "",
      ].join("\n"),
    };
  }
  if (planned.action === "unchanged") {
    return { exitCode: 0, output: `Unchanged ${options.relativePath}\n` };
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  const temporary = `${target}.cq-tmp`;
  await writeFile(temporary, planned.next, { mode: 0o644, flag: "w" });
  await rename(temporary, target);
  return {
    exitCode: 0,
    output: `${planned.action === "create" ? "Created" : "Updated"} ${options.relativePath}\n`,
  };
}

export async function installSkillFiles(options: {
  readonly root: string;
  readonly skillSourceDir: string;
  readonly confirm?: boolean;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const destination = join(options.root, "skills", "code-quality-review");
  assertSafeTarget(options.root, destination);
  if (options.confirm !== true) {
    return {
      exitCode: 0,
      output: [
        "Skill install plan (read-only until --confirm):",
        `from: ${options.skillSourceDir}`,
        `to: ${destination}`,
        "Re-run with --confirm to apply.",
        "",
      ].join("\n"),
    };
  }
  await mkdir(destination, { recursive: true, mode: 0o755 });
  const skillMd = await readFile(
    join(options.skillSourceDir, "SKILL.md"),
    "utf8",
  );
  await writeFile(join(destination, "SKILL.md"), skillMd, {
    mode: 0o644,
    flag: "w",
  });
  try {
    await access(join(options.skillSourceDir, "references"), constants.R_OK);
    await mkdir(join(destination, "references"), { recursive: true });
    for (const name of ["codex.md", "claude-code.md"]) {
      const body = await readFile(
        join(options.skillSourceDir, "references", name),
        "utf8",
      );
      await writeFile(join(destination, "references", name), body, {
        mode: 0o644,
        flag: "w",
      });
    }
  } catch {
    // references optional
  }
  await chmod(destination, 0o755);
  return { exitCode: 0, output: `Installed skill into ${destination}\n` };
}
