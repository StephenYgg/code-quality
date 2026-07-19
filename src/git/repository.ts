import { realpath } from "node:fs/promises";
import { TextDecoder } from "node:util";

import {
  GitCommandError,
  runGitCommand,
  type TrustedGitExecution,
} from "./commands.js";

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const MAX_REVISION_BYTES = 300;

export type GitRepositoryErrorCode =
  "GIT_NOT_REPOSITORY" | "GIT_REVISION_INVALID";

export class GitRepositoryError extends Error {
  constructor(
    readonly code: GitRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitRepositoryError";
  }
}

function singleLine(stdout: Buffer, message: string): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true })
      .decode(stdout)
      .replace(/\r?\n$/u, "");
  } catch {
    throw new GitRepositoryError("GIT_NOT_REPOSITORY", message);
  }
  if (value.length === 0 || /[\r\n\0]/u.test(value)) {
    throw new GitRepositoryError("GIT_NOT_REPOSITORY", message);
  }
  return value;
}

function validateRevision(revision: string): void {
  let hasControlCharacter = false;
  for (const character of revision) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      hasControlCharacter = true;
      break;
    }
  }
  if (
    revision.length === 0 ||
    revision.startsWith("-") ||
    hasControlCharacter ||
    Buffer.byteLength(revision, "utf8") > MAX_REVISION_BYTES
  ) {
    throw new GitRepositoryError(
      "GIT_REVISION_INVALID",
      "Git revision is invalid",
    );
  }
}

export async function resolveGitRepository(
  requestedPath: string,
  signal?: AbortSignal,
  execution?: TrustedGitExecution,
): Promise<string> {
  let requestedRealPath: string;
  try {
    requestedRealPath = await realpath(requestedPath);
    const result = await runGitCommand({
      repository: requestedRealPath,
      args: ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      maximumStdoutBytes: 8 * 1024,
      signal,
      execution,
    });
    return await realpath(
      singleLine(result.stdout, "Repository root is invalid"),
    );
  } catch (error) {
    if (error instanceof GitRepositoryError) throw error;
    if (error instanceof GitCommandError) throw error;
    throw new GitRepositoryError(
      "GIT_NOT_REPOSITORY",
      "Path is not a readable Git worktree",
    );
  }
}

export async function resolveCommit(
  repository: string,
  revision: string,
  signal?: AbortSignal,
  execution?: TrustedGitExecution,
): Promise<string> {
  validateRevision(revision);
  try {
    const result = await runGitCommand({
      repository,
      args: [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${revision}^{commit}`,
      ],
      maximumStdoutBytes: 256,
      signal,
      execution,
    });
    const objectId = singleLine(result.stdout, "Git revision is invalid");
    if (!OBJECT_ID.test(objectId)) throw new Error("invalid object id");
    return objectId;
  } catch (error) {
    if (
      error instanceof GitCommandError &&
      error.code !== "GIT_COMMAND_FAILED"
    ) {
      throw error;
    }
    throw new GitRepositoryError(
      "GIT_REVISION_INVALID",
      "Git revision could not be resolved to a commit",
    );
  }
}

export async function resolveFirstParent(
  repository: string,
  commit: string,
  signal?: AbortSignal,
  execution?: TrustedGitExecution,
): Promise<string | undefined> {
  const result = await runGitCommand({
    repository,
    args: ["rev-list", "--parents", "-n", "1", commit],
    maximumStdoutBytes: 512,
    signal,
    execution,
  });
  const values = singleLine(result.stdout, "Commit parents are invalid").split(
    " ",
  );
  const parent = values[1];
  if (parent !== undefined && !OBJECT_ID.test(parent)) {
    throw new GitRepositoryError(
      "GIT_REVISION_INVALID",
      "Commit parent is invalid",
    );
  }
  return parent;
}
