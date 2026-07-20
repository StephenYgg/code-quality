import { Option } from "commander";

export interface CliWriter {
  write(chunk: string): unknown;
}

export interface CliIo {
  readonly stdout: CliWriter;
  readonly stderr: CliWriter;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface CommandContext {
  readonly io: CliIo;
  readonly setExitCode: (exitCode: number) => void;
}

export function writeCommandResult(
  context: CommandContext,
  result: CommandResult,
): void {
  context.setExitCode(result.exitCode);
  context.io.stdout.write(result.output);
}

export function outputFormatOption(): Option {
  return new Option("--format <format>", "output format")
    .choices(["terminal", "json"])
    .default("terminal");
}
