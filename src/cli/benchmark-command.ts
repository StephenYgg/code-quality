import type { Command } from "commander";

import { runBenchmarkCommand } from "../commands/benchmark.js";
import type { CommandOutputFormat } from "../commands/output.js";
import {
  type CommandContext,
  outputFormatOption,
  writeCommandResult,
} from "./command-context.js";

export function registerBenchmarkCommand(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("benchmark")
    .description("run the bounded benchmark corpus and report quality metrics")
    .option(
      "--manifest <path>",
      "benchmark manifest",
      "benchmarks/manifest.yaml",
    )
    .option("--observations <path>", "external provider observations JSON")
    .addOption(outputFormatOption())
    .action(
      async (options: {
        readonly manifest: string;
        readonly observations?: string;
        readonly format: CommandOutputFormat;
      }) => {
        writeCommandResult(
          context,
          await runBenchmarkCommand({
            manifestPath: options.manifest,
            ...(options.observations === undefined
              ? {}
              : { observationsPath: options.observations }),
            format: options.format,
          }),
        );
      },
    );
}
