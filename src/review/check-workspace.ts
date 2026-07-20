import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import type { ImmutableReviewInput } from "../core/review-input.js";
import { runGitCommand } from "../git/commands.js";
import { captureLocalGitReviewInput } from "../git/inputs.js";

export class CheckWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckWorkspaceError";
  }
}

export interface CheckWorkspace {
  readonly path: string;
  dispose(): Promise<void>;
}

export async function materializeStagedCheckWorkspace(options: {
  readonly repository: string;
  readonly input: ImmutableReviewInput;
  readonly signal?: AbortSignal;
}): Promise<CheckWorkspace> {
  if (options.input.snapshot.inputKind !== "staged") {
    throw new CheckWorkspaceError(
      "Staged check workspace requires staged input",
    );
  }
  const directory = await mkdtemp(join(tmpdir(), "cq-staged-check-"));
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(directory, { force: true, recursive: true });
  };
  try {
    await runGitCommand({
      repository: options.repository,
      args: [
        "checkout-index",
        "--all",
        "--force",
        `--prefix=${directory}${sep}`,
      ],
      timeoutMs: 30_000,
      maximumStdoutBytes: 1024 * 1024,
      maximumStderrBytes: 64 * 1024,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const current = await captureLocalGitReviewInput({
      repository: options.repository,
      staged: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (
      current.snapshot.contentHash !== options.input.snapshot.contentHash ||
      current.contentBundleHash !== options.input.contentBundleHash
    ) {
      throw new CheckWorkspaceError(
        "Staged input changed while the check workspace was materialized",
      );
    }
    return Object.freeze({ path: directory, dispose });
  } catch (error) {
    await dispose();
    if (error instanceof CheckWorkspaceError) throw error;
    throw new CheckWorkspaceError(
      error instanceof Error
        ? error.message
        : "Staged check workspace could not be materialized",
    );
  }
}
