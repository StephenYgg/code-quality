import type { Command } from "commander";

import {
  runHooksInstallCommand,
  runHooksRunCommand,
  runHooksStatusCommand,
  runHooksUninstallCommand,
} from "../commands/hooks.js";
import { type CommandContext, writeCommandResult } from "./command-context.js";

export function registerHooksCommand(
  program: Command,
  context: CommandContext,
): void {
  const hooks = program
    .command("hooks")
    .description("install, inspect, or remove optional local git hooks");
  hooks
    .command("install")
    .description("install managed pre-commit and pre-push hooks")
    .option("--mode <mode>", "warn or block", "warn")
    .option("--preset <preset>", "balanced or strict", "balanced")
    .option("--confirm", "apply the installation plan")
    .action(
      async (options: {
        readonly mode: string;
        readonly preset: string;
        readonly confirm?: boolean;
      }) => {
        if (options.mode !== "warn" && options.mode !== "block") {
          context.setExitCode(2);
          context.io.stderr.write("Error: hooks mode must be warn or block\n");
          return;
        }
        writeCommandResult(
          context,
          await runHooksInstallCommand({
            mode: options.mode,
            preset: options.preset === "strict" ? "strict" : "balanced",
            ...(options.confirm === true ? { confirm: true } : {}),
          }),
        );
      },
    );
  hooks
    .command("status")
    .description("show managed hook status")
    .action(async () => {
      writeCommandResult(context, await runHooksStatusCommand({}));
    });
  hooks
    .command("run")
    .description(
      "execute a managed hook phase (used by installed hooks; supports fail-open)",
    )
    .argument("<phase>", "pre-commit or pre-push")
    .option("--mode <mode>", "warn or block", "warn")
    .option("--preset <preset>", "balanced or strict", "balanced")
    .option("--repository <path>", "repository directory", ".")
    .action(
      async (
        phase: string,
        options: {
          readonly mode: string;
          readonly preset: string;
          readonly repository: string;
        },
      ) => {
        if (options.mode !== "warn" && options.mode !== "block") {
          context.setExitCode(2);
          context.io.stderr.write("Error: hooks mode must be warn or block\n");
          return;
        }
        if (options.preset !== "balanced" && options.preset !== "strict") {
          context.setExitCode(2);
          context.io.stderr.write(
            "Error: hooks preset must be balanced or strict\n",
          );
          return;
        }
        writeCommandResult(
          context,
          await runHooksRunCommand({
            phase,
            mode: options.mode,
            preset: options.preset,
            repository: options.repository,
          }),
        );
      },
    );
  hooks
    .command("uninstall")
    .description("remove managed hook content")
    .option("--confirm", "apply the uninstall plan")
    .action(async (options: { readonly confirm?: boolean }) => {
      writeCommandResult(
        context,
        await runHooksUninstallCommand({
          ...(options.confirm === true ? { confirm: true } : {}),
        }),
      );
    });
}
