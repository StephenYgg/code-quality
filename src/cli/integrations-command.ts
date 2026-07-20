import type { Command } from "commander";

import {
  runIntegrationsInstallCommand,
  runIntegrationsStatusCommand,
} from "../commands/integrations.js";
import { type CommandContext, writeCommandResult } from "./command-context.js";

type IntegrationTarget = "claude" | "codex" | "project";

function integrationTarget(value: string): IntegrationTarget | undefined {
  return value === "codex" || value === "claude" || value === "project"
    ? value
    : undefined;
}

export function registerIntegrationsCommand(
  program: Command,
  context: CommandContext,
): void {
  const integrations = program
    .command("integrations")
    .description("plan or install managed Agent/Skill integration blocks");
  integrations
    .command("install")
    .description("install managed integration snippets and optional skills")
    .requiredOption("--target <target>", "codex, claude, or project")
    .option("--root <path>", "absolute integration root for host installs")
    .option("--confirm", "apply the planned installation")
    .action(
      async (options: {
        readonly target: string;
        readonly root?: string;
        readonly confirm?: boolean;
      }) => {
        const target = integrationTarget(options.target);
        if (target === undefined) {
          context.setExitCode(2);
          context.io.stderr.write(
            "Error: target must be codex, claude, or project\n",
          );
          return;
        }
        writeCommandResult(
          context,
          await runIntegrationsInstallCommand({
            target,
            ...(options.root === undefined ? {} : { root: options.root }),
            ...(options.confirm === true ? { confirm: true } : {}),
          }),
        );
      },
    );
  integrations
    .command("status")
    .description("show the planned managed integration action")
    .requiredOption("--target <target>", "codex, claude, or project")
    .option("--root <path>", "absolute integration root for host installs")
    .action(
      async (options: { readonly target: string; readonly root?: string }) => {
        const target = integrationTarget(options.target);
        if (target === undefined) {
          context.setExitCode(2);
          context.io.stderr.write(
            "Error: target must be codex, claude, or project\n",
          );
          return;
        }
        writeCommandResult(
          context,
          await runIntegrationsStatusCommand({
            target,
            ...(options.root === undefined ? {} : { root: options.root }),
          }),
        );
      },
    );
}
