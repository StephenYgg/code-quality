import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  createImmutableReviewInput,
  type ImmutableReviewInput,
} from "../core/review-input.js";
import { createReviewSnapshot } from "../core/snapshots.js";
import type { ReviewSnapshot } from "../core/snapshots.js";
import {
  resolveTrustedGitExecution,
  runGitCommand,
  type GitConfigEntry,
  type TrustedGitExecution,
} from "../git/commands.js";
import { captureLocalGitReviewInput } from "../git/inputs.js";
import {
  acquireLock,
  LockError,
  releaseLock,
  type LockHandle,
} from "../storage/locks.js";
import { platformCacheDirectory } from "../storage/paths.js";
import type { ForgeCredentials } from "./forge.js";
import type { ParsedForgeUrl } from "./url.js";

const MIRROR_LOCK_WAIT_MS = 30_000;
const MIRROR_LOCK_LEASE_MS = 120_000;
const MIRROR_LOCK_POLL_MS = 25;

export class ForgeMaterializeError extends Error {
  constructor(
    readonly code:
      | "FORGE_MATERIALIZE_FAILED"
      | "FORGE_MATERIALIZE_INVALID"
      | "FORGE_MATERIALIZE_STALE",
    message: string,
  ) {
    super(message);
    this.name = "ForgeMaterializeError";
  }
}

export interface MaterializedForgeCheckout {
  readonly barePath: string;
  readonly baseWorktree: string;
  readonly headWorktree: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly snapshot: ReviewSnapshot;
  readonly reviewInput: ImmutableReviewInput;
  readonly cloneUrl: string;
  dispose(): Promise<void>;
}

function bareCachePath(url: ParsedForgeUrl, env?: NodeJS.ProcessEnv): string {
  const safeHost = url.host.replace(/[^a-zA-Z0-9._-]/gu, "_");
  const safeOwner = url.owner.replace(/[^a-zA-Z0-9._/-]/gu, "_");
  const safeRepo = url.repository.replace(/[^a-zA-Z0-9._-]/gu, "_");
  return join(
    platformCacheDirectory(env),
    "bare",
    safeHost,
    safeOwner,
    `${safeRepo}.git`,
  );
}

export function forgeCloneUrl(url: ParsedForgeUrl): string {
  return `https://${url.host}/${url.owner}/${url.repository}.git`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function authorizationConfig(
  cloneUrl: string,
  credentials: ForgeCredentials | undefined,
): readonly GitConfigEntry[] {
  if (credentials?.token === undefined) return [];
  let host: string;
  try {
    host = new URL(cloneUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (host !== "github.com" && host !== "gitlab.com") return [];
  return [
    {
      key: `http.https://${host}/.extraHeader`,
      value: `Authorization: Bearer ${credentials.token}`,
    },
  ];
}

async function ensureCommit(
  barePath: string,
  sha: string,
  execution: TrustedGitExecution,
  cloneUrl: string,
  credentials?: ForgeCredentials,
): Promise<void> {
  try {
    await runGitCommand({
      repository: barePath,
      args: ["cat-file", "-e", `${sha}^{commit}`],
      execution,
    });
  } catch {
    await runGitCommand({
      repository: barePath,
      args: ["fetch", "--quiet", "--no-tags", cloneUrl, sha],
      execution,
      gitConfig: authorizationConfig(cloneUrl, credentials),
      maximumStdoutBytes: 1024 * 1024,
    });
    await runGitCommand({
      repository: barePath,
      args: ["cat-file", "-e", `${sha}^{commit}`],
      execution,
    });
  }
}

interface BareMirrorOptions {
  readonly url: ParsedForgeUrl;
  readonly cloneUrl?: string;
  readonly credentials?: ForgeCredentials;
  readonly env?: NodeJS.ProcessEnv;
}

interface BareMirror {
  readonly barePath: string;
  readonly execution: TrustedGitExecution;
}

export interface MaterializeForgeOptions {
  readonly url: ParsedForgeUrl;
  readonly baseSha: string;
  readonly headSha: string;
  readonly cloneUrl?: string;
  readonly headCloneUrl?: string;
  readonly credentials?: ForgeCredentials;
  readonly env?: NodeJS.ProcessEnv;
}

async function ensureBareMirrorUnlocked(
  options: BareMirrorOptions,
  refreshExisting: boolean,
): Promise<BareMirror> {
  const barePath = bareCachePath(options.url, options.env);
  const parent = dirname(barePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const execution = await resolveTrustedGitExecution(parent);
  const cloneUrl = options.cloneUrl ?? forgeCloneUrl(options.url);
  const auth = authorizationConfig(cloneUrl, options.credentials);
  const isRepo = await pathExists(join(barePath, "HEAD"));

  if (!isRepo) {
    await runGitCommand({
      repository: parent,
      args: ["clone", "--bare", "--quiet", "--", cloneUrl, barePath],
      execution,
      gitConfig: auth,
      maximumStdoutBytes: 1024 * 1024,
    });
  } else if (refreshExisting) {
    // Refresh without rewriting remote URL (credentials never stored there).
    await runGitCommand({
      repository: barePath,
      args: ["fetch", "--quiet", "origin", "--prune"],
      execution,
      gitConfig: auth,
      maximumStdoutBytes: 1024 * 1024,
    });
  }
  return { barePath, execution };
}

export async function ensureBareMirror(
  options: BareMirrorOptions,
): Promise<BareMirror> {
  return withMirrorMutationLock(options.url, options.env, () =>
    ensureBareMirrorUnlocked(options, true),
  );
}

function assertValidForgeRevisions(options: MaterializeForgeOptions): void {
  if (
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(options.baseSha) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(options.headSha)
  ) {
    throw new ForgeMaterializeError(
      "FORGE_MATERIALIZE_INVALID",
      "Forge base/head SHAs are invalid",
    );
  }
}

async function acquireRequiredCommits(
  options: MaterializeForgeOptions,
): Promise<BareMirror> {
  const cloneUrl = options.cloneUrl ?? forgeCloneUrl(options.url);
  const headCloneUrl = options.headCloneUrl ?? cloneUrl;
  return withMirrorMutationLock(options.url, options.env, async () => {
    const mirror = await ensureBareMirrorUnlocked(
      {
        url: options.url,
        ...(options.cloneUrl === undefined
          ? {}
          : { cloneUrl: options.cloneUrl }),
        ...(options.credentials === undefined
          ? {}
          : { credentials: options.credentials }),
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      false,
    );
    await ensureCommit(
      mirror.barePath,
      options.baseSha,
      mirror.execution,
      cloneUrl,
      options.credentials,
    );
    await ensureCommit(
      mirror.barePath,
      options.headSha,
      mirror.execution,
      headCloneUrl,
      options.credentials,
    );
    return mirror;
  });
}

export async function materializeForgeChange(
  options: MaterializeForgeOptions,
): Promise<MaterializedForgeCheckout> {
  assertValidForgeRevisions(options);
  const { barePath, execution } = await acquireRequiredCommits(options);

  const session = createHash("sha256")
    .update(randomUUID())
    .update(options.headSha)
    .digest("hex")
    .slice(0, 16);
  const worktreeRoot = join(
    platformCacheDirectory(options.env),
    "worktrees",
    session,
  );
  const baseWorktree = join(worktreeRoot, "base");
  const headWorktree = join(worktreeRoot, "head");
  await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const path of [baseWorktree, headWorktree]) {
      try {
        await runGitCommand({
          repository: barePath,
          args: ["worktree", "remove", "--force", path],
          execution,
        });
      } catch {
        // fall through
      }
    }
    await rm(worktreeRoot, { force: true, recursive: true });
  };

  try {
    await runGitCommand({
      repository: barePath,
      args: [
        "worktree",
        "add",
        "--detach",
        "--quiet",
        baseWorktree,
        options.baseSha,
      ],
      execution,
    });
    await runGitCommand({
      repository: barePath,
      args: [
        "worktree",
        "add",
        "--detach",
        "--quiet",
        headWorktree,
        options.headSha,
      ],
      execution,
    });

    const rangeInput = await captureLocalGitReviewInput({
      repository: headWorktree,
      range: `${options.baseSha}..${options.headSha}`,
    });
    const rangeSnapshot = rangeInput.snapshot;
    const snapshot = createReviewSnapshot({
      inputKind: options.url.kind === "github" ? "github_pr" : "gitlab_mr",
      scope: "change",
      repository: `${options.url.owner}/${options.url.repository}`,
      comparisonBase: options.baseSha,
      head: options.headSha,
      files: rangeSnapshot.files,
      exclusions: rangeSnapshot.exclusions,
      incomplete: rangeSnapshot.incomplete,
      ...(rangeSnapshot.diff === undefined ? {} : { diff: rangeSnapshot.diff }),
    });
    const reviewInput = createImmutableReviewInput(
      snapshot,
      rangeInput.contentByPath,
    );

    return {
      barePath,
      baseWorktree,
      headWorktree,
      baseSha: options.baseSha,
      headSha: options.headSha,
      snapshot,
      reviewInput,
      cloneUrl: options.cloneUrl ?? forgeCloneUrl(options.url),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw new ForgeMaterializeError(
      "FORGE_MATERIALIZE_FAILED",
      error instanceof Error
        ? error.message
        : "Forge change could not be materialized",
    );
  }
}

function mirrorLockKey(url: ParsedForgeUrl): string {
  return createHash("sha256")
    .update("cq-forge-bare-mirror:v1\0")
    .update(url.host)
    .update("\0")
    .update(url.owner)
    .update("\0")
    .update(url.repository)
    .digest("hex");
}

async function withMirrorMutationLock<T>(
  url: ParsedForgeUrl,
  env: NodeJS.ProcessEnv | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await waitForMirrorLock(mirrorLockKey(url), env);
  try {
    return await operation();
  } finally {
    await releaseLock(lock);
  }
}

async function waitForMirrorLock(
  key: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<LockHandle> {
  const deadline = Date.now() + MIRROR_LOCK_WAIT_MS;
  for (;;) {
    try {
      return await acquireLock(key, {
        ttlMs: MIRROR_LOCK_LEASE_MS,
        ...(env === undefined ? {} : { env }),
      });
    } catch (error) {
      if (!(error instanceof LockError) || error.code !== "LOCK_BUSY") {
        throw error;
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ForgeMaterializeError(
        "FORGE_MATERIALIZE_FAILED",
        "Timed out waiting for the local bare mirror mutation lock",
      );
    }
    const jitterMs = MIRROR_LOCK_POLL_MS + Math.floor(Math.random() * 25);
    await delay(Math.min(jitterMs, remainingMs));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
