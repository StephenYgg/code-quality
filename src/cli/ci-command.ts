import type { Command } from "commander";

import { runCiInstallCommand, runCiStatusCommand } from "../commands/ci.js";
import { type CommandContext, writeCommandResult } from "./command-context.js";

export function registerCiCommand(
  program: Command,
  context: CommandContext,
): void {
  const ci = program
    .command("ci")
    .description(
      "plan or install CI templates (activation requires ops confirmation)",
    );
  ci.command("status")
    .description("show whether CI templates are installed in a repository")
    .argument("[repository]", "repository directory", ".")
    .action(async (repository: string) => {
      writeCommandResult(context, await runCiStatusCommand({ repository }));
    });
  ci.command("install")
    .description("copy a CI template into the repository after --confirm")
    .requiredOption("--target <target>", "github or gitlab")
    .argument("[repository]", "repository directory", ".")
    .option("--confirm", "write the destination file")
    .option("--force", "overwrite an existing destination file")
    .action(
      async (
        repository: string,
        options: {
          readonly target: string;
          readonly confirm?: boolean;
          readonly force?: boolean;
        },
      ) => {
        writeCommandResult(
          context,
          await runCiInstallCommand({
            repository,
            target: options.target,
            ...(options.confirm === true ? { confirm: true } : {}),
            ...(options.force === true ? { force: true } : {}),
          }),
        );
      },
    );
}
