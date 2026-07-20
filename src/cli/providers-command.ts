import { type Command, Option } from "commander";

import type { CommandOutputFormat } from "../commands/output.js";
import { runProvidersValidateCommand } from "../commands/providers.js";
import {
  type CommandContext,
  outputFormatOption,
  writeCommandResult,
} from "./command-context.js";

export function registerProvidersCommand(
  program: Command,
  context: CommandContext,
): void {
  const providers = program
    .command("providers")
    .description(
      "validate trusted user providers without sending repository content",
    );
  providers
    .command("validate")
    .description(
      "soak-probe local CLI safe-mode flags/versions and validate HTTP provider config",
    )
    .option("--config <path>", "absolute path to trusted user config.yaml")
    .option(
      "--live",
      "opt-in live soak (CQ_PROVIDER_LIVE_SOAK=1); may call providers/forges with synthetic payloads only",
    )
    .option(
      "--forge-token-env <name>",
      "when --live, probe this forge token env (read-only)",
    )
    .addOption(
      new Option(
        "--forge <forge>",
        "github or gitlab read-only probe origin",
      ).choices(["github", "gitlab"]),
    )
    .addOption(outputFormatOption())
    .action(
      async (options: {
        readonly config?: string;
        readonly format: CommandOutputFormat;
        readonly live?: boolean;
        readonly forgeTokenEnv?: string;
        readonly forge?: "github" | "gitlab";
      }) => {
        writeCommandResult(
          context,
          await runProvidersValidateCommand({
            format: options.format,
            ...(options.config === undefined
              ? {}
              : { configPath: options.config }),
            ...(options.live === true ? { live: true } : {}),
            ...(options.forgeTokenEnv === undefined
              ? {}
              : { forgeTokenEnv: options.forgeTokenEnv }),
            ...(options.forge === undefined ? {} : { forge: options.forge }),
          }),
        );
      },
    );
}
