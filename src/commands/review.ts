import { writeFile } from "node:fs/promises";

import { captureLocalGitInput } from "../git/inputs.js";
import {
  collectRepositoryManifest,
  createRepositoryPreflight,
  reconfirmRepository,
  repositoryCaptureToSnapshot,
} from "../git/repository-manifest.js";
import { parseForgeUrl } from "../forges/url.js";
import { GitHubForgeReader } from "../forges/github.js";
import { GitLabForgeReader } from "../forges/gitlab.js";
import type { ReviewProvider } from "../providers/provider.js";
import { renderReviewJson } from "../reporters/review-json.js";
import { renderReviewMarkdown } from "../reporters/review-markdown.js";
import { renderReviewTerminal } from "../reporters/review-terminal.js";
import { runReview } from "../review/orchestrator.js";
import { storeRun } from "../storage/runs.js";
import type { CommandOutputFormat } from "./output.js";

export interface ReviewCommandOptions {
  readonly worktree?: boolean;
  readonly staged?: boolean;
  readonly commit?: string;
  readonly range?: string;
  readonly repository?: string | true;
  readonly preflight?: boolean;
  readonly confirmFullRepository?: string;
  readonly forgeUrl?: string;
  readonly format?: CommandOutputFormat | "markdown";
  readonly output?: string;
  readonly provider?: ReviewProvider;
  readonly signal?: AbortSignal;
}

export interface ReviewCommandResult {
  readonly exitCode: number;
  readonly output: string;
}

const defaultContext = {
  policyHash: "0".repeat(64),
  providerClass: "none",
  endpointClass: "none",
  egressClass: "local",
  budgets: { maxTokens: 0, maxDurationMs: 0, maxCostUsd: 0 },
};

function gateExitCode(gate: string, incomplete: boolean): number {
  if (incomplete || gate === "INCOMPLETE") return 3;
  if (gate === "BLOCK") return 1;
  return 0;
}

export async function runReviewCommand(
  options: ReviewCommandOptions,
): Promise<ReviewCommandResult> {
  const selectors = [
    options.worktree === true,
    options.staged === true,
    options.commit !== undefined,
    options.range !== undefined,
    options.repository !== undefined,
    options.forgeUrl !== undefined,
  ].filter(Boolean);
  if (selectors.length !== 1) {
    return {
      exitCode: 2,
      output: "Exactly one review input selector is required\n",
    };
  }

  if (options.repository !== undefined) {
    const repository = options.repository === true ? "." : options.repository;
    if (options.preflight === true) {
      const capture = await collectRepositoryManifest(
        {
          repository,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        defaultContext,
      );
      const preflight = createRepositoryPreflight(capture, defaultContext);
      const output =
        options.format === "json"
          ? `${JSON.stringify(preflight, null, 2)}\n`
          : [
              "Full-repository preflight",
              `repository: ${preflight.repository}`,
              `head: ${preflight.head}`,
              `selected: ${String(preflight.selectedFileCount)} files / ${String(preflight.selectedByteCount)} bytes`,
              `incomplete: ${preflight.incomplete ? "yes" : "no"}`,
              `confirmationHash: ${preflight.confirmationHash}`,
              "",
            ].join("\n");
      return { exitCode: preflight.incomplete ? 3 : 0, output };
    }
    if (options.confirmFullRepository === undefined) {
      return {
        exitCode: 2,
        output:
          "Full-repository review requires --preflight or --confirm-full-repository <hash>\n",
      };
    }
    const capture = await reconfirmRepository(
      options.confirmFullRepository,
      {
        repository,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      defaultContext,
    );
    if (options.provider === undefined) {
      return {
        exitCode: 2,
        output: "A review provider is required for full-repository execution\n",
      };
    }
    const snapshot = repositoryCaptureToSnapshot(capture);
    const result = await runReview({
      provider: options.provider,
      snapshot,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await storeRun(result);
    return render(result, options);
  }

  if (options.forgeUrl !== undefined) {
    const parsed = parseForgeUrl(options.forgeUrl);
    const reader =
      parsed.kind === "github"
        ? new GitHubForgeReader()
        : new GitLabForgeReader();
    const read = await reader.read(
      parsed,
      {},
      { fetch: globalThis.fetch.bind(globalThis) },
    );
    if (options.provider === undefined) {
      return {
        exitCode: 2,
        output: "A review provider is required for forge execution\n",
      };
    }
    const result = await runReview({
      provider: options.provider,
      snapshot: read.snapshot,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await storeRun(result);
    return render(result, options);
  }

  const snapshot = await captureLocalGitInput({
    repository: ".",
    ...(options.worktree === true ? { worktree: true } : {}),
    ...(options.staged === true ? { staged: true } : {}),
    ...(options.commit === undefined ? {} : { commit: options.commit }),
    ...(options.range === undefined ? {} : { range: options.range }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (options.provider === undefined) {
    return {
      exitCode: 2,
      output: "A review provider is required\n",
    };
  }
  const result = await runReview({
    provider: options.provider,
    snapshot,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  await storeRun(result);
  return render(result, options);
}

async function render(
  result: Awaited<ReturnType<typeof runReview>>,
  options: ReviewCommandOptions,
): Promise<ReviewCommandResult> {
  const format = options.format ?? "terminal";
  const output =
    format === "json"
      ? renderReviewJson(result)
      : format === "markdown"
        ? renderReviewMarkdown(result)
        : renderReviewTerminal(result);
  if (options.output !== undefined) {
    await writeFile(options.output, output, { mode: 0o600, flag: "wx" });
  }
  return {
    exitCode: gateExitCode(result.gate, result.incomplete),
    output,
  };
}
