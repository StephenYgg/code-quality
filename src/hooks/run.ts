import { access } from "node:fs/promises";
import { extname, join } from "node:path";

import { runReadabilityInspectCommand } from "../commands/inspect.js";
import { runReviewCommand } from "../commands/review.js";
import { captureLocalGitInput } from "../git/inputs.js";
import { resolveUpstreamRange, UpstreamError } from "../git/upstream.js";
import {
  HOOK_PRESETS,
  phaseConfigFor,
  resolveHookExitCode,
  type HookMode,
  type HookPhase,
  type HookPhaseConfig,
  type HookPreset,
} from "./presets.js";

const READABILITY_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

export async function runManagedHook(options: {
  readonly phase: HookPhase;
  readonly mode: HookMode;
  readonly preset: HookPreset;
  readonly repository?: string;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const repository = options.repository ?? ".";
  const definition = HOOK_PRESETS[options.preset];
  const phase = phaseConfigFor(options.preset, options.phase);
  const lines: string[] = [
    `code-quality hook: ${options.phase}`,
    `mode: ${options.mode}`,
    `preset: ${options.preset}`,
    `execution: ${phase.execution}`,
    `input: ${phase.input}`,
    `failOpenOnIncomplete: ${definition.failOpenOnIncomplete ? "yes" : "no"}`,
    `budget: files<=${String(phase.budget.maxFiles)} attempts<=${String(phase.budget.maxProviderAttempts)} durationMs<=${String(phase.budget.maxDurationMs)}`,
    `cacheKey: includes snapshot+policy+prompt+provider+model+preset(${options.preset})`,
    "",
  ];

  if (phase.runDeterministicReadability) {
    const readability = await runDeterministicReadabilityPass({
      repository,
      phase,
      maxFiles: Math.min(8, phase.budget.maxFiles),
    });
    lines.push("Deterministic readability:");
    lines.push(readability.output.trimEnd());
    lines.push("");
    if (readability.exitCode === 1 && options.mode === "block") {
      lines.push(
        "Hook policy: deterministic readability reported BLOCK; stopping in block mode",
      );
      return { exitCode: 1, output: `${lines.join("\n")}\n` };
    }
  }

  let reviewArgs: {
    readonly staged?: boolean;
    readonly worktree?: boolean;
    readonly range?: string;
  };
  if (phase.input === "staged") {
    reviewArgs = { staged: true };
  } else if (phase.input === "worktree") {
    reviewArgs = { worktree: true };
  } else {
    try {
      const upstream = await resolveUpstreamRange({ repository });
      lines.push(
        `Upstream range: ${upstream.upstreamRef} merge-base ${upstream.baseSha.slice(0, 12)}..${upstream.headSha.slice(0, 12)}`,
      );
      lines.push("");
      reviewArgs = { range: upstream.range };
    } catch (error) {
      const message =
        error instanceof UpstreamError
          ? error.message
          : "Failed to resolve upstream range";
      lines.push(`Upstream range unavailable: ${message}`);
      lines.push("Falling back to worktree review.");
      lines.push("");
      reviewArgs = { worktree: true };
    }
  }

  const review = await runReviewCommand({
    ...reviewArgs,
    reviewPreset: phase.execution,
    hookPreset: options.preset,
    score: true,
    format: "terminal",
    maxOutputTokens: phase.budget.maxOutputTokens,
    timeoutMs: Math.min(phase.budget.maxDurationMs, 120_000),
  });
  lines.push("Review:");
  lines.push(review.output.trimEnd());
  lines.push("");

  const resolved = resolveHookExitCode({
    mode: options.mode,
    reviewExitCode: review.exitCode,
    failOpenOnIncomplete: definition.failOpenOnIncomplete,
  });
  if (resolved.note !== undefined) {
    lines.push(`Hook policy: ${resolved.note}`);
    lines.push("");
  }
  return {
    exitCode: resolved.exitCode,
    output: `${lines.join("\n")}\n`,
  };
}

async function runDeterministicReadabilityPass(options: {
  readonly repository: string;
  readonly phase: HookPhaseConfig;
  readonly maxFiles: number;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  try {
    let snapshot;
    if (options.phase.input === "upstream_range") {
      try {
        const upstream = await resolveUpstreamRange({
          repository: options.repository,
        });
        snapshot = await captureLocalGitInput({
          repository: options.repository,
          range: upstream.range,
        });
      } catch {
        snapshot = await captureLocalGitInput({
          repository: options.repository,
          worktree: true,
        });
      }
    } else {
      snapshot = await captureLocalGitInput({
        repository: options.repository,
        ...(options.phase.input === "staged"
          ? { staged: true }
          : { worktree: true }),
      });
    }
    const candidates = snapshot.files
      .filter(
        (file) =>
          !file.binary &&
          file.status !== "deleted" &&
          READABILITY_EXTENSIONS.has(extname(file.path).toLowerCase()),
      )
      .slice(0, options.maxFiles);
    if (candidates.length === 0) {
      return {
        exitCode: 0,
        output: "- no TypeScript/JavaScript files in hook input\n",
      };
    }
    const chunks: string[] = [];
    let worstExit = 0;
    for (const file of candidates) {
      const absolute = join(options.repository, file.path);
      try {
        await access(absolute);
      } catch {
        chunks.push(`- ${file.path}: skipped (not present in worktree)`);
        continue;
      }
      const result = await runReadabilityInspectCommand(absolute, "terminal");
      worstExit = Math.max(worstExit, result.exitCode);
      chunks.push(`- ${file.path}: exit=${String(result.exitCode)}`);
      const preview = result.output
        .split("\n")
        .slice(0, 20)
        .join("\n")
        .trimEnd();
      if (preview.length > 0) chunks.push(preview);
    }
    return { exitCode: worstExit, output: `${chunks.join("\n")}\n` };
  } catch (error) {
    return {
      exitCode: 3,
      output: `readability pass incomplete: ${error instanceof Error ? error.message : "unknown error"}\n`,
    };
  }
}
