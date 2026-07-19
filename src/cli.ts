#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command, CommanderError, Option } from "commander";

import {
  runHooksInstallCommand,
  runHooksStatusCommand,
  runHooksUninstallCommand,
} from "./commands/hooks.js";
import { runInitCommand } from "./commands/init.js";
import { runReadabilityInspectCommand } from "./commands/inspect.js";
import type { CommandOutputFormat } from "./commands/output.js";
import { runReportCommand } from "./commands/report.js";
import { runReviewCommand } from "./commands/review.js";
import { runRuleExplainCommand, runRuleListCommand } from "./commands/rules.js";
import { runRunsListCommand } from "./commands/runs.js";
import { runScoreCommand } from "./commands/score.js";
import { runValidateCommand } from "./commands/validate.js";
import { escapeTerminalField } from "./reporters/terminal-safe.js";

export interface CliWriter {
  write(chunk: string): unknown;
}

export interface CliIo {
  readonly stdout: CliWriter;
  readonly stderr: CliWriter;
}

function defaultIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown CLI error";
  return escapeTerminalField(message);
}

function outputFormatOption(): Option {
  return new Option("--format <format>", "output format")
    .choices(["terminal", "json"])
    .default("terminal");
}

export function isExecutedModule(
  executable: string,
  moduleUrl: string,
): boolean {
  try {
    return realpathSync(executable) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo(),
): Promise<number> {
  const program = new Command();
  let commandExitCode = 0;

  program
    .name("cq")
    .description("Evidence-driven code review quality checks")
    .version("0.1.0")
    .exitOverride()
    .configureOutput({
      writeOut: (value) => io.stdout.write(value),
      writeErr: (value) => io.stderr.write(value),
      outputError: (value, write) => {
        write(`${escapeTerminalField(value)}\n`);
      },
    });

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
        const result = await runValidateCommand(repository, options.format);
        commandExitCode = result.exitCode;
        io.stdout.write(result.output);
      },
    );

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
        const result = await runRuleListCommand({
          format: options.format,
          ...(options.profile === undefined
            ? {}
            : { profileName: options.profile }),
        });
        commandExitCode = result.exitCode;
        io.stdout.write(result.output);
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
        const result = await runRuleExplainCommand(ruleId, {
          format: options.format,
          ...(options.profile === undefined
            ? {}
            : { profileName: options.profile }),
        });
        commandExitCode = result.exitCode;
        io.stdout.write(result.output);
      },
    );

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
        const result = await runReadabilityInspectCommand(
          input,
          options.format,
        );
        commandExitCode = result.exitCode;
        io.stdout.write(result.output);
      },
    );

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
        const result = await runScoreCommand(input, options.format);
        commandExitCode = result.exitCode;
        io.stdout.write(result.output);
      },
    );

  program
    .command("review")
    .description("run a bounded review against one input selector")
    .option("--worktree", "review the worktree against HEAD")
    .option("--staged", "review the staged index against HEAD")
    .option("--commit <sha>", "review a single commit")
    .option("--range <range>", "review a base..head range")
    .option("--repository [path]", "full-repository review or preflight")
    .option("--preflight", "emit repository preflight without provider calls")
    .option(
      "--confirm-full-repository <hash>",
      "confirm a full-repository preflight hash",
    )
    .option("--forge-url <url>", "review a GitHub PR or GitLab MR URL")
    .option("--output <path>", "write the report to a new file")
    .addOption(
      new Option("--format <format>", "output format")
        .choices(["terminal", "json", "markdown"])
        .default("terminal"),
    )
    .action(
      async (options: {
        readonly worktree?: boolean;
        readonly staged?: boolean;
        readonly commit?: string;
        readonly range?: string;
        readonly repository?: string | true;
        readonly preflight?: boolean;
        readonly confirmFullRepository?: string;
        readonly forgeUrl?: string;
        readonly output?: string;
        readonly format: CommandOutputFormat | "markdown";
      }) => {
        const result = await runReviewCommand({
          ...(options.worktree === true ? { worktree: true } : {}),
          ...(options.staged === true ? { staged: true } : {}),
          ...(options.commit === undefined ? {} : { commit: options.commit }),
          ...(options.range === undefined ? {} : { range: options.range }),
          ...(options.repository === undefined
            ? {}
            : { repository: options.repository }),
          ...(options.preflight === true ? { preflight: true } : {}),
          ...(options.confirmFullRepository === undefined
            ? {}
            : { confirmFullRepository: options.confirmFullRepository }),
          ...(options.forgeUrl === undefined
            ? {}
            : { forgeUrl: options.forgeUrl }),
          ...(options.output === undefined ? {} : { output: options.output }),
          format: options.format,
        });
        commandExitCode = result.exitCode;
        io.stdout.write(result.output);
      },
    );

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
        const result = await runReportCommand(runId, options.format);
        commandExitCode = result.exitCode;
        io.stdout.write(result.output);
      },
    );

  program
    .command("runs")
    .description("list recent stored runs")
    .addOption(outputFormatOption())
    .action(async (options: { readonly format: CommandOutputFormat }) => {
      const result = await runRunsListCommand(options.format);
      commandExitCode = result.exitCode;
      io.stdout.write(result.output);
    });

  program
    .command("init")
    .description("create a repository quality profile plan or apply it")
    .option("--confirm", "apply the planned files")
    .argument("[repository]", "repository directory", ".")
    .action(
      async (repository: string, options: { readonly confirm?: boolean }) => {
        const result = await runInitCommand({
          repository,
          ...(options.confirm === true ? { confirm: true } : {}),
        });
        commandExitCode = result.exitCode;
        io.stdout.write(result.output);
      },
    );

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
          commandExitCode = 2;
          io.stderr.write("Error: hooks mode must be warn or block\n");
          return;
        }
        const result = await runHooksInstallCommand({
          mode: options.mode,
          preset: options.preset === "strict" ? "strict" : "balanced",
          ...(options.confirm === true ? { confirm: true } : {}),
        });
        commandExitCode = result.exitCode;
        io.stdout.write(result.output);
      },
    );
  hooks
    .command("status")
    .description("show managed hook status")
    .action(async () => {
      const result = await runHooksStatusCommand({});
      commandExitCode = result.exitCode;
      io.stdout.write(result.output);
    });
  hooks
    .command("uninstall")
    .description("remove managed hook content")
    .option("--confirm", "apply the uninstall plan")
    .action(async (options: { readonly confirm?: boolean }) => {
      const result = await runHooksUninstallCommand({
        ...(options.confirm === true ? { confirm: true } : {}),
      });
      commandExitCode = result.exitCode;
      io.stdout.write(result.output);
    });

  try {
    if (argv.length === 0) {
      program.outputHelp();
      return 0;
    }
    await program.parseAsync([...argv], { from: "user" });
    return commandExitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
        ? 0
        : 2;
    }
    io.stderr.write(`Error: ${errorMessage(error)}\n`);
    return 2;
  }
}

const executable = process.argv[1];
if (executable !== undefined && isExecutedModule(executable, import.meta.url)) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
