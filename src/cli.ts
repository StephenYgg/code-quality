#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import { registerBenchmarkCommand } from "./cli/benchmark-command.js";
import { registerCiCommand } from "./cli/ci-command.js";
import type { CliIo, CommandContext } from "./cli/command-context.js";
import { registerDeterministicCommands } from "./cli/deterministic-commands.js";
import { registerHooksCommand } from "./cli/hooks-command.js";
import { registerIntegrationsCommand } from "./cli/integrations-command.js";
import { registerProvidersCommand } from "./cli/providers-command.js";
import { registerReviewCommand } from "./cli/review-command.js";
import { registerStateCommands } from "./cli/state-commands.js";
import { escapeTerminalField } from "./reporters/terminal-safe.js";

export type { CliIo, CliWriter } from "./cli/command-context.js";

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
  const context: CommandContext = {
    io,
    setExitCode(exitCode) {
      commandExitCode = exitCode;
    },
  };

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

  registerDeterministicCommands(program, context);
  registerReviewCommand(program, context);
  registerProvidersCommand(program, context);
  registerBenchmarkCommand(program, context);
  registerCiCommand(program, context);
  registerStateCommands(program, context);
  registerIntegrationsCommand(program, context);
  registerHooksCommand(program, context);

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
