import type { Command } from "commander";

import { runReadabilityInspectCommand } from "../commands/inspect.js";
import type { CommandOutputFormat } from "../commands/output.js";
import {
  runRuleExplainCommand,
  runRuleListCommand,
} from "../commands/rules.js";
import { runScoreCommand } from "../commands/score.js";
import { runValidateCommand } from "../commands/validate.js";
import {
  type CommandContext,
  outputFormatOption,
  writeCommandResult,
} from "./command-context.js";

export function registerDeterministicCommands(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("validate")
    .description("validate repository quality policy without invoking a model")
    .argument("[repository]", "repository directory", ".")
    .addOption(outputFormatOption())
    .action(
      async (
        repository: string,
        options: { readonly format: CommandOutputFormat },
      ) => {
        writeCommandResult(
          context,
          await runValidateCommand(repository, options.format),
        );
      },
    );

  registerRulesCommand(program, context);
  registerInspectCommand(program, context);

  program
    .command("score")
    .description("calculate a versioned score from a bounded JSON assessment")
    .argument("<input>", "score assessment JSON file")
    .addOption(outputFormatOption())
    .action(
      async (
        input: string,
        options: { readonly format: CommandOutputFormat },
      ) => {
        writeCommandResult(
          context,
          await runScoreCommand(input, options.format),
        );
      },
    );
}

function registerRulesCommand(program: Command, context: CommandContext): void {
  const rules = program
    .command("rules")
    .description("list or explain rules in the effective policy");
  rules
    .command("list")
    .description("list effective rules")
    .option("--profile <name>", "repository profile name")
    .addOption(outputFormatOption())
    .action(
      async (options: {
        readonly format: CommandOutputFormat;
        readonly profile?: string;
      }) => {
        writeCommandResult(
          context,
          await runRuleListCommand({
            format: options.format,
            ...(options.profile === undefined
              ? {}
              : { profileName: options.profile }),
          }),
        );
      },
    );
  rules
    .command("explain")
    .description("explain one effective rule")
    .argument("<rule-id>", "stable rule ID")
    .option("--profile <name>", "repository profile name")
    .addOption(outputFormatOption())
    .action(
      async (
        ruleId: string,
        options: {
          readonly format: CommandOutputFormat;
          readonly profile?: string;
        },
      ) => {
        writeCommandResult(
          context,
          await runRuleExplainCommand(ruleId, {
            format: options.format,
            ...(options.profile === undefined
              ? {}
              : { profileName: options.profile }),
          }),
        );
      },
    );
}

function registerInspectCommand(
  program: Command,
  context: CommandContext,
): void {
  const inspect = program
    .command("inspect")
    .description("run focused deterministic analysis");
  inspect
    .command("readability")
    .description("inspect TypeScript or JavaScript readability")
    .argument("<input>", "source file")
    .addOption(outputFormatOption())
    .action(
      async (
        input: string,
        options: { readonly format: CommandOutputFormat },
      ) => {
        writeCommandResult(
          context,
          await runReadabilityInspectCommand(input, options.format),
        );
      },
    );
}
