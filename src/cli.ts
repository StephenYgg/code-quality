#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command, CommanderError, Option } from "commander";

import {
  runValidateCommand,
  type ValidationOutputFormat,
} from "./commands/validate.js";
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
    .addOption(
      new Option("--format <format>", "output format")
        .choices(["terminal", "json"])
        .default("terminal"),
    )
    .action(
      async (
        repository: string,
        options: { readonly format: ValidationOutputFormat },
      ) => {
        const result = await runValidateCommand(repository, options.format);
        commandExitCode = result.exitCode;
        io.stdout.write(result.output);
      },
    );

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
