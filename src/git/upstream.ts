import { runGitCommand } from "./commands.js";
import { resolveCommit } from "./repository.js";

export class UpstreamError extends Error {
  constructor(
    readonly code: "UPSTREAM_MISSING" | "UPSTREAM_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface UpstreamRange {
  readonly baseSha: string;
  readonly headSha: string;
  readonly range: string;
  readonly upstreamRef: string;
}

/**
 * Resolve the range of commits since the current branch's upstream tracking
 * base (@{upstream}). Falls back to origin/HEAD or origin/main when upstream
 * is not configured.
 */
export async function resolveUpstreamRange(options: {
  readonly repository: string;
  readonly signal?: AbortSignal;
}): Promise<UpstreamRange> {
  const headSha = await resolveCommit(
    options.repository,
    "HEAD",
    options.signal,
  );

  const candidates = [
    "@{upstream}",
    "origin/HEAD",
    "origin/main",
    "origin/master",
  ];
  let upstreamRef: string | undefined;
  let baseSha: string | undefined;

  for (const candidate of candidates) {
    try {
      const resolved = await resolveCommit(
        options.repository,
        candidate,
        options.signal,
      );
      // Ensure the revision is an ancestor or merge-base related; use merge-base.
      const merge = await runGitCommand({
        repository: options.repository,
        args: ["merge-base", resolved, headSha],
        maximumStdoutBytes: 4_096,
        maximumStderrBytes: 4_096,
        timeoutMs: 10_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const mergeBase = merge.stdout.toString("utf8").trim();
      if (/^[0-9a-f]{40,64}$/iu.test(mergeBase)) {
        upstreamRef = candidate;
        baseSha = mergeBase.toLowerCase();
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (baseSha === undefined || upstreamRef === undefined) {
    throw new UpstreamError(
      "UPSTREAM_MISSING",
      "No upstream tracking branch or origin default branch is available for pre-push range review",
    );
  }

  return {
    baseSha,
    headSha,
    range: `${baseSha}..${headSha}`,
    upstreamRef,
  };
}
