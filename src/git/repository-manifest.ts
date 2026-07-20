import { createHash } from "node:crypto";

import { compareCodeUnits } from "../core/deterministic-order.js";
import {
  decodeGitUtf8,
  hashSnapshotParts,
  type SnapshotExclusion,
  type SnapshotExclusionReason,
} from "../core/snapshots.js";
import {
  scanRepositoryPathSet,
  type RepositoryPathSet,
} from "./bounded-path-set.js";
import {
  resolveTrustedGitExecution,
  runGitCommand,
  type TrustedGitExecution,
} from "./commands.js";
import {
  classifyRepositoryPath,
  exclusionCountRecord,
  isBinaryContent,
  isValidUtf8,
  looksLikeSecret,
  pushExclusion,
  validatePath,
} from "./repository-content-policy.js";
import { createRepositoryCapture } from "./repository-capture.js";
import { resolveCommit, resolveGitRepository } from "./repository.js";
import {
  inspectWorktreePath,
  safeReadWorktreeFile,
  WorktreeSourceStaleError,
  type WorktreePathEpoch,
} from "./safe-worktree-read.js";
import { resolveRepositoryManifestLimits } from "./repository-limits.js";
import {
  RepositoryManifestError,
  type RepositoryCapture,
  type RepositoryFileContent,
  type RepositoryManifestContext,
  type RepositoryManifestLimits,
  type RepositoryManifestRequest,
} from "./repository-manifest-types.js";
import { repositoryConfirmationHash } from "./repository-preflight.js";

const MAX_PATH_SET_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_IGNORED_OUTPUT_BYTES = 2 * 1024 * 1024;

export {
  classifyRepositoryPath,
  isBinaryContent,
  looksLikeSecret,
  MAX_EXCLUSION_SAMPLES_PER_REASON,
} from "./repository-content-policy.js";
export {
  repositoryCaptureToReviewInput,
  repositoryCaptureToSnapshot,
} from "./repository-review-input.js";

export {
  DEFAULT_REPOSITORY_BYTE_LIMIT,
  DEFAULT_REPOSITORY_ENTRY_LIMIT,
  DEFAULT_REPOSITORY_FILE_LIMIT,
  DEFAULT_REPOSITORY_INDIVIDUAL_FILE_BYTES,
  MAX_REPOSITORY_BYTE_LIMIT,
  MAX_REPOSITORY_FILE_LIMIT,
} from "./repository-limits.js";
export { RepositoryManifestError };
export type {
  RepositoryCapture,
  RepositoryDiagnosticPreflight,
  RepositoryFileContent,
  RepositoryManifestContext,
  RepositoryManifestIo,
  RepositoryManifestLimits,
  RepositoryManifestRequest,
  RepositoryPreflight,
} from "./repository-manifest-types.js";
export { isPathInsideRepository } from "./repository-path.js";
export {
  createRepositoryDiagnosticPreflight,
  createRepositoryPreflight,
} from "./repository-preflight.js";

async function gitNullPathBuffer(
  repository: string,
  args: readonly string[],
  execution: TrustedGitExecution,
  signal?: AbortSignal,
  maximumStdoutBytes = MAX_PATH_SET_OUTPUT_BYTES,
): Promise<Buffer> {
  const result = await runGitCommand({
    repository,
    args,
    execution,
    signal,
    maximumStdoutBytes,
  });
  return result.stdout;
}

async function resolveIndexIdentity(
  repository: string,
  execution: TrustedGitExecution,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGitCommand({
    repository,
    args: ["write-tree"],
    execution,
    signal,
    maximumStdoutBytes: 128,
  });
  const identity = decodeGitUtf8(result.stdout).trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(identity)) {
    throw new RepositoryManifestError(
      "REPOSITORY_UNSAFE",
      "Git index identity is invalid",
    );
  }
  return identity;
}

async function readPathBytes(
  repository: string,
  relativePath: string,
  maxBytes: number,
  expectedEpoch?: WorktreePathEpoch,
): Promise<
  | {
      readonly ok: true;
      readonly bytes: Buffer;
      readonly epoch: WorktreePathEpoch;
    }
  | { readonly ok: false; readonly reason: SnapshotExclusionReason }
> {
  try {
    const read = await safeReadWorktreeFile({
      repository,
      path: relativePath,
      maxBytes,
      ...(expectedEpoch === undefined ? {} : { expectedEpoch }),
    });
    return read.ok
      ? { ok: true, bytes: read.bytes, epoch: read.epoch }
      : { ok: false, reason: read.reason };
  } catch (error) {
    if (error instanceof WorktreeSourceStaleError) {
      throw new RepositoryManifestError(
        "REPOSITORY_SOURCE_STALE",
        "Repository path identity changed during capture",
      );
    }
    throw error;
  }
}

function hashCapture(
  head: string,
  selected: readonly RepositoryFileContent[],
  exclusions: readonly SnapshotExclusion[],
  exclusionCounts: Readonly<Record<string, number>>,
  pathSetHash: string,
  limits: RepositoryManifestLimits,
): string {
  const parts: Buffer[] = [
    Buffer.from(head, "utf8"),
    Buffer.from(pathSetHash, "utf8"),
    Buffer.from(JSON.stringify(exclusionCounts), "utf8"),
    Buffer.from(
      JSON.stringify({
        maxFiles: limits.maxFiles,
        maxBytes: limits.maxBytes,
        maxEntries: limits.maxEntries,
        maxIndividualFileBytes: limits.maxIndividualFileBytes,
      }),
      "utf8",
    ),
  ];
  for (const file of selected) {
    parts.push(
      Buffer.from(
        `${file.tracked ? "T" : "U"}:${file.path}:${String(file.size)}:${file.contentHash}`,
        "utf8",
      ),
    );
    parts.push(file.bytes);
  }
  for (const exclusion of exclusions) {
    parts.push(
      Buffer.from(`${exclusion.reason}:${exclusion.path ?? ""}`, "utf8"),
    );
  }
  return hashSnapshotParts(parts);
}

async function captureCandidateEpochs(
  repository: string,
  candidates: readonly { readonly path: string }[],
): Promise<ReadonlyMap<string, WorktreePathEpoch>> {
  const epochs = new Map<string, WorktreePathEpoch>();
  for (const candidate of candidates) {
    const epoch = await inspectWorktreePath(repository, candidate.path);
    if (epoch !== undefined) epochs.set(candidate.path, epoch);
  }
  return epochs;
}

async function verifySelectedEpochs(options: {
  readonly repository: string;
  readonly selected: readonly RepositoryFileContent[];
  readonly epochByPath: ReadonlyMap<string, WorktreePathEpoch>;
  readonly maxBytes: number;
}): Promise<void> {
  for (const file of options.selected) {
    const expectedEpoch = options.epochByPath.get(file.path);
    if (expectedEpoch === undefined) throw repositorySourceStale();
    const current = await readPathBytes(
      options.repository,
      file.path,
      options.maxBytes,
      expectedEpoch,
    );
    if (!current.ok || !current.bytes.equals(file.bytes)) {
      throw repositorySourceStale();
    }
    const contentHash = createHash("sha256")
      .update(current.bytes)
      .digest("hex");
    if (contentHash !== file.contentHash) throw repositorySourceStale();
  }
}

function repositorySourceStale(): RepositoryManifestError {
  return new RepositoryManifestError(
    "REPOSITORY_SOURCE_STALE",
    "Repository source changed during capture",
  );
}

async function verifyRepositorySource(options: {
  readonly repository: string;
  readonly head: string;
  readonly indexIdentity: string;
  readonly pathSet: RepositoryPathSet;
  readonly selected: readonly RepositoryFileContent[];
  readonly epochByPath: ReadonlyMap<string, WorktreePathEpoch>;
  readonly execution: TrustedGitExecution;
  readonly limits: RepositoryManifestLimits;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const [head, indexIdentity, tracked, untracked, ignored] = await Promise.all([
    resolveCommit(
      options.repository,
      "HEAD",
      options.signal,
      options.execution,
    ),
    resolveIndexIdentity(options.repository, options.execution, options.signal),
    gitNullPathBuffer(
      options.repository,
      ["ls-files", "-z", "--"],
      options.execution,
      options.signal,
    ),
    gitNullPathBuffer(
      options.repository,
      ["ls-files", "--others", "--exclude-standard", "-z", "--"],
      options.execution,
      options.signal,
    ),
    gitNullPathBuffer(
      options.repository,
      ["ls-files", "--others", "-i", "--exclude-standard", "-z", "--"],
      options.execution,
      options.signal,
      MAX_IGNORED_OUTPUT_BYTES,
    ),
  ]);
  const pathSet = scanRepositoryPathSet({ tracked, untracked, ignored }, 0);
  if (
    head !== options.head ||
    indexIdentity !== options.indexIdentity ||
    pathSet.hash !== options.pathSet.hash ||
    pathSet.entryCount !== options.pathSet.entryCount ||
    pathSet.trackedCount !== options.pathSet.trackedCount ||
    pathSet.untrackedCount !== options.pathSet.untrackedCount ||
    pathSet.ignoredCount !== options.pathSet.ignoredCount
  ) {
    throw repositorySourceStale();
  }
  await verifySelectedEpochs({
    repository: options.repository,
    selected: options.selected,
    epochByPath: options.epochByPath,
    maxBytes: options.limits.maxIndividualFileBytes,
  });
}

interface RepositoryCandidate {
  readonly path: string;
  readonly tracked: boolean;
}

interface CandidateEnumeration {
  readonly candidates: readonly RepositoryCandidate[];
  readonly exclusions: SnapshotExclusion[];
  readonly counts: Map<string, number>;
  readonly samples: Map<string, number>;
  readonly incomplete: boolean;
}

function enumerateCandidates(options: {
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
  readonly ignored: readonly string[];
  readonly overflowCount: number;
}): CandidateEnumeration {
  const exclusions: SnapshotExclusion[] = [];
  const counts = new Map<string, number>();
  const samples = new Map<string, number>();
  let incomplete = options.overflowCount > 0;
  const candidates: RepositoryCandidate[] = [];
  for (const [paths, tracked] of [
    [options.tracked, true],
    [options.untracked, false],
  ] as const) {
    for (const rawPath of paths) {
      const path = validatePath(rawPath);
      if (path === undefined) {
        incomplete = true;
        pushExclusion(exclusions, counts, samples, "path_limit", rawPath);
        continue;
      }
      const classified = classifyRepositoryPath(path);
      if (classified !== undefined) {
        pushExclusion(exclusions, counts, samples, classified, path);
        continue;
      }
      candidates.push({ path, tracked });
    }
  }
  for (const path of options.ignored) {
    pushExclusion(exclusions, counts, samples, "git_ignored", path);
  }
  if (options.overflowCount > 0) {
    pushExclusion(
      exclusions,
      counts,
      samples,
      "entry_limit",
      undefined,
      options.overflowCount,
    );
  }
  candidates.sort((left, right) => compareCodeUnits(left.path, right.path));
  return { candidates, exclusions, counts, samples, incomplete };
}

async function selectCandidates(options: {
  readonly repository: string;
  readonly candidates: readonly RepositoryCandidate[];
  readonly candidateEpochs: ReadonlyMap<string, WorktreePathEpoch>;
  readonly enumeration: CandidateEnumeration;
  readonly limits: RepositoryManifestLimits;
}): Promise<{
  readonly selected: readonly RepositoryFileContent[];
  readonly selectedEpochs: ReadonlyMap<string, WorktreePathEpoch>;
  readonly incomplete: boolean;
}> {
  const selected: RepositoryFileContent[] = [];
  const selectedEpochs = new Map<string, WorktreePathEpoch>();
  let selectedBytes = 0;
  let incomplete = options.enumeration.incomplete;
  const exclude = (reason: SnapshotExclusionReason, path: string) => {
    pushExclusion(
      options.enumeration.exclusions,
      options.enumeration.counts,
      options.enumeration.samples,
      reason,
      path,
    );
  };
  for (const candidate of options.candidates) {
    if (selected.length >= options.limits.maxFiles) {
      incomplete = true;
      exclude("aggregate_file_limit", candidate.path);
      continue;
    }
    const read = await readPathBytes(
      options.repository,
      candidate.path,
      options.limits.maxIndividualFileBytes,
      options.candidateEpochs.get(candidate.path),
    );
    if (!read.ok) {
      incomplete = true;
      exclude(read.reason, candidate.path);
      continue;
    }
    if (selectedBytes + read.bytes.length > options.limits.maxBytes) {
      incomplete = true;
      exclude("aggregate_byte_limit", candidate.path);
      continue;
    }
    if (isBinaryContent(read.bytes)) {
      exclude("binary", candidate.path);
      continue;
    }
    if (!isValidUtf8(read.bytes)) {
      incomplete = true;
      exclude("unsupported_type", candidate.path);
      continue;
    }
    if (looksLikeSecret(read.bytes)) {
      exclude("suspected_secret", candidate.path);
      continue;
    }
    const contentHash = createHash("sha256").update(read.bytes).digest("hex");
    selected.push({
      path: candidate.path,
      tracked: candidate.tracked,
      size: read.bytes.length,
      contentHash,
      bytes: read.bytes,
    });
    selectedEpochs.set(candidate.path, read.epoch);
    selectedBytes += read.bytes.length;
  }
  return { selected, selectedEpochs, incomplete };
}

async function verifyCapturedRepositorySource(
  request: RepositoryManifestRequest,
  repository: string,
  head: string,
  indexIdentity: string,
  pathSet: RepositoryPathSet,
  selected: readonly RepositoryFileContent[],
  selectedEpochs: ReadonlyMap<string, WorktreePathEpoch>,
  execution: TrustedGitExecution,
  limits: RepositoryManifestLimits,
): Promise<void> {
  await verifyRepositorySource({
    repository,
    head,
    indexIdentity,
    pathSet,
    selected,
    epochByPath: selectedEpochs,
    execution,
    limits,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

export async function collectRepositoryManifest(
  request: RepositoryManifestRequest,
  _context?: RepositoryManifestContext,
  limitOverrides?: Partial<RepositoryManifestLimits>,
): Promise<RepositoryCapture> {
  const limits = resolveRepositoryManifestLimits(limitOverrides);
  const execution = await resolveTrustedGitExecution(request.repository);
  const repository = await resolveGitRepository(
    request.repository,
    request.signal,
    execution,
  );
  const head = await resolveCommit(
    repository,
    "HEAD",
    request.signal,
    execution,
  );
  const indexIdentity = await resolveIndexIdentity(
    repository,
    execution,
    request.signal,
  );

  const tracked = await gitNullPathBuffer(
    repository,
    ["ls-files", "-z", "--"],
    execution,
    request.signal,
  );
  const untracked = await gitNullPathBuffer(
    repository,
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    execution,
    request.signal,
  );
  const ignored = await gitNullPathBuffer(
    repository,
    ["ls-files", "--others", "-i", "--exclude-standard", "-z", "--"],
    execution,
    request.signal,
    MAX_IGNORED_OUTPUT_BYTES,
  );
  const pathSet = scanRepositoryPathSet(
    { tracked, untracked, ignored },
    limits.maxEntries,
  );

  const enumeration = enumerateCandidates({
    tracked: pathSet.tracked,
    untracked: pathSet.untracked,
    ignored: pathSet.ignored,
    overflowCount: pathSet.overflowCount,
  });
  const { candidates, exclusions } = enumeration;
  const candidateEpochs = await captureCandidateEpochs(repository, candidates);
  await request.io?.afterEnumeration?.();
  const selection = await selectCandidates({
    repository,
    candidates,
    candidateEpochs,
    enumeration,
    limits,
  });
  const { selected, selectedEpochs, incomplete } = selection;

  await request.io?.beforeSourceVerification?.();
  await verifyCapturedRepositorySource(
    request,
    repository,
    head,
    indexIdentity,
    pathSet,
    selected,
    selectedEpochs,
    execution,
    limits,
  );

  const exclusionCounts = exclusionCountRecord(enumeration.counts);
  const contentHash = hashCapture(
    head,
    selected,
    exclusions,
    exclusionCounts,
    pathSet.hash,
    limits,
  );
  return createRepositoryCapture(
    repository,
    head,
    pathSet,
    selected,
    exclusions,
    exclusionCounts,
    incomplete,
    limits,
    contentHash,
  );
}

export async function reconfirmRepository(
  expectedConfirmationHash: string,
  request: RepositoryManifestRequest,
  context: RepositoryManifestContext,
  limitOverrides?: Partial<RepositoryManifestLimits>,
): Promise<RepositoryCapture> {
  if (
    expectedConfirmationHash.length !== 64 ||
    !/^[a-f0-9]{64}$/u.test(expectedConfirmationHash)
  ) {
    throw new RepositoryManifestError(
      "REPOSITORY_CONFIRMATION_MISMATCH",
      "Full-repository confirmation hash is invalid",
    );
  }
  const capture = await collectRepositoryManifest(
    request,
    context,
    limitOverrides,
  );
  if (
    repositoryConfirmationHash(capture.contentHash, context) !==
    expectedConfirmationHash
  ) {
    throw new RepositoryManifestError(
      "REPOSITORY_CONFIRMATION_MISMATCH",
      "Full-repository confirmation hash does not match the current manifest",
    );
  }
  return capture;
}
