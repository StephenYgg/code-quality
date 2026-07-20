import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  installManagedIntegration,
  installSkillFiles,
} from "../instructions/integrations.js";
import { platformConfigDirectory } from "../core/user-config.js";

export type IntegrationTarget = "codex" | "claude" | "project";

export interface IntegrationsCommandOptions {
  readonly target: IntegrationTarget;
  readonly root?: string;
  readonly confirm?: boolean;
  readonly repository?: string;
}

function packageRoot(): string {
  // dist/commands -> repo root in dev/build layouts
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..");
}

export async function runIntegrationsInstallCommand(
  options: IntegrationsCommandOptions,
): Promise<{ readonly exitCode: number; readonly output: string }> {
  if (options.target === "project") {
    const repository = options.repository ?? ".";
    const agents = await installManagedIntegration({
      root: repository,
      relativePath: "AGENTS.md",
      ...(options.confirm === true ? { confirm: true } : {}),
    });
    if (agents.exitCode !== 0) return agents;
    const claude = await installManagedIntegration({
      root: repository,
      relativePath: "CLAUDE.md",
      ...(options.confirm === true ? { confirm: true } : {}),
      block: `<!-- code-quality managed block begin -->
# Claude Agent Instructions

## Canonical Instructions

Before taking any action, read the sibling \`AGENTS.md\` in full and comply with it.

## Tool-Specific Delta

None.
<!-- code-quality managed block end -->
`,
    });
    return {
      exitCode: claude.exitCode,
      output: `${agents.output}${claude.output}`,
    };
  }

  const root =
    options.root ??
    (options.target === "codex"
      ? join(platformConfigDirectory(), "codex-integration")
      : join(platformConfigDirectory(), "claude-integration"));
  const agentsPath = options.target === "codex" ? "AGENTS.md" : "CLAUDE.md";
  const agents = await installManagedIntegration({
    root,
    relativePath: agentsPath,
    ...(options.confirm === true ? { confirm: true } : {}),
  });
  if (agents.exitCode !== 0) return agents;
  const skills = await installSkillFiles({
    root,
    skillSourceDir: join(packageRoot(), "skills", "code-quality-review"),
    ...(options.confirm === true ? { confirm: true } : {}),
  });
  return {
    exitCode: skills.exitCode,
    output: `${agents.output}${skills.output}`,
  };
}

export async function runIntegrationsStatusCommand(options: {
  readonly target: IntegrationTarget;
  readonly root?: string;
  readonly repository?: string;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const root =
    options.target === "project"
      ? (options.repository ?? ".")
      : (options.root ??
        join(
          platformConfigDirectory(),
          options.target === "codex"
            ? "codex-integration"
            : "claude-integration",
        ));
  const relativePath = options.target === "claude" ? "CLAUDE.md" : "AGENTS.md";
  const plan = await installManagedIntegration({
    root,
    relativePath,
    confirm: false,
  });
  return plan;
}
