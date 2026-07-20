import { type Command, Option } from "commander";

import { runInitCommand } from "../commands/init.js";
import type { CommandOutputFormat } from "../commands/output.js";
import { runReportCommand } from "../commands/report.js";
import { runRunsListCommand } from "../commands/runs.js";
import { runStorageStatusCommand } from "../commands/storage-status.js";
import {
  type CommandContext,
  outputFormatOption,
  writeCommandResult,
} from "./command-context.js";

export function registerStateCommands(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("storage")
    .description("show state/cache/lock coordination directories and counts")
    .action(async () => {
      writeCommandResult(context, await runStorageStatusCommand());
    });

  program
    .command("report")
    .description("render a stored run report")
    .argument("<run-id>", "stored run id")
    .addOption(
      new Option("--format <format>", "output format")
        .choices(["terminal", "json", "markdown"])
        .default("terminal"),
    )
    .action(
      async (
        runId: string,
        options: { readonly format: CommandOutputFormat | "markdown" },
      ) => {
        writeCommandResult(
          context,
          await runReportCommand(runId, options.format),
        );
      },
    );

  program
    .command("runs")
    .description("list recent stored runs")
    .addOption(outputFormatOption())
    .action(async (options: { readonly format: CommandOutputFormat }) => {
      writeCommandResult(context, await runRunsListCommand(options.format));
    });

  program
    .command("init")
    .description("create a repository quality profile plan or apply it")
    .option("--confirm", "apply the planned files")
    .argument("[repository]", "repository directory", ".")
    .action(
      async (repository: string, options: { readonly confirm?: boolean }) => {
        writeCommandResult(
          context,
          await runInitCommand({
            repository,
            ...(options.confirm === true ? { confirm: true } : {}),
          }),
        );
      },
    );
}
