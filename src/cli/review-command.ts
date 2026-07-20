import { type Command, Option } from "commander";

import type { CommandOutputFormat } from "../commands/output.js";
import {
  runReviewCommand,
  type ReviewCommandOptions,
} from "../commands/review.js";
import { type CommandContext, writeCommandResult } from "./command-context.js";

interface ReviewCliOptions {
  readonly worktree?: boolean;
  readonly staged?: boolean;
  readonly commit?: string;
  readonly range?: string;
  readonly repository?: string | true;
  readonly preflight?: boolean;
  readonly confirmFullRepository?: string;
  readonly forgeUrl?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly config?: string;
  readonly publish?: boolean;
  readonly yes?: boolean;
  readonly publishTokenEnv?: string;
  readonly runChecks?: boolean;
  readonly runChecksPreview?: boolean;
  readonly score?: boolean;
  readonly reviewPreset?: string;
  readonly retainTranscript?: boolean;
  readonly output?: string;
  readonly format: CommandOutputFormat | "markdown";
}

function reviewCommandOptions(options: ReviewCliOptions): ReviewCommandOptions {
  return {
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
    ...(options.forgeUrl === undefined ? {} : { forgeUrl: options.forgeUrl }),
    ...(options.provider === undefined
      ? {}
      : { providerName: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.config === undefined ? {} : { configPath: options.config }),
    ...(options.publish === true ? { publish: true } : {}),
    ...(options.yes === true ? { yes: true } : {}),
    ...(options.publishTokenEnv === undefined
      ? {}
      : { publishTokenEnv: options.publishTokenEnv }),
    ...(options.runChecks === true ? { runChecks: true } : {}),
    ...(options.runChecksPreview === true
      ? { runChecks: true, runChecksPreviewOnly: true }
      : {}),
    ...(options.score === true ? { score: true } : {}),
    ...(options.reviewPreset === "fast" || options.reviewPreset === "full"
      ? { reviewPreset: options.reviewPreset }
      : {}),
    ...(options.retainTranscript === true ? { retainTranscript: true } : {}),
    ...(options.output === undefined ? {} : { output: options.output }),
    format: options.format,
  };
}

export function registerReviewCommand(
  program: Command,
  context: CommandContext,
): void {
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
    .option("--provider <name>", "trusted provider name from user config")
    .option("--model <name>", "allowed model for the selected provider")
    .option("--config <path>", "absolute path to trusted user config.yaml")
    .option("--publish", "publish the report to the forge change")
    .option("--yes", "confirm a dangerous non-interactive action")
    .option(
      "--publish-token-env <name>",
      "environment variable holding the forge token",
      "CQ_FORGE_TOKEN",
    )
    .option("--run-checks", "run authorized local verification commands")
    .option(
      "--run-checks-preview",
      "preview run-checks commands without executing them",
    )
    .option("--score", "append the full 100.0 score model report")
    .option(
      "--review-preset <preset>",
      "review execution preset: full or fast",
      "full",
    )
    .option(
      "--retain-transcript",
      "write a redacted 0600 transcript and mark the run sensitive",
    )
    .option("--output <path>", "write the report to a new file")
    .addOption(
      new Option("--format <format>", "output format")
        .choices(["terminal", "json", "markdown"])
        .default("terminal"),
    )
    .action(async (options: ReviewCliOptions) => {
      if (
        options.reviewPreset !== undefined &&
        options.reviewPreset !== "full" &&
        options.reviewPreset !== "fast"
      ) {
        context.setExitCode(2);
        context.io.stderr.write(
          "Error: --review-preset must be full or fast\n",
        );
        return;
      }
      writeCommandResult(
        context,
        await runReviewCommand(reviewCommandOptions(options)),
      );
    });
}
