import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  hashSnapshotParts,
  MAX_SNAPSHOT_DIFF_BYTES,
  parseGitDiffEnvelope,
  splitNullRecords,
  decodeGitUtf8,
  type SnapshotFile,
} from "../core/snapshots.js";
import {
  GitCommandError,
  runGitCommand,
  type TrustedGitExecution,
} from "./commands.js";

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_FILTER_DRIVERS = 64;
const FILTER_DRIVER = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$/u;
const EMPTY_FILTER_SAFETY: FilterSafety = {
  hasExecutable: false,
  identity: Buffer.alloc(0),
};

export type LocalInputKind = "worktree" | "staged" | "commit" | "range";
export type DiffMode = "worktree" | "staged" | "pair" | "root";

export interface DiffPlan {
  readonly kind: LocalInputKind;
  readonly mode: DiffMode;
  readonly comparisonBase?: string;
  readonly resolvedHead: string;
  readonly commitRevision?: string;
  readonly baseRevision?: string;
  readonly headRevision?: string;
}

export interface CapturedMaterial {
  readonly attributes: Buffer;
  readonly filterConfig: Buffer;
  readonly raw: Buffer;
  readonly numstat: Buffer;
  readonly patch: Buffer;
  readonly status?: Buffer;
  readonly untracked?: Buffer;
}

export interface DiffCollectionIo {
  readonly beforeDiffCommand?: (args: readonly string[]) => Promise<void>;
  readonly afterFilterVerificationBeforeSpawn?: () => Promise<void>;
}

export class GitDiffError extends Error {
  constructor(
    readonly code:
      | "GIT_INPUT_LIMIT_EXCEEDED"
      | "GIT_SOURCE_STALE"
      | "GIT_UNSAFE_CONFIGURATION",
    message: string,
  ) {
    super(message);
    this.name = "GitDiffError";
  }
}

interface FilterSafety {
  readonly hasExecutable: boolean;
  readonly identity: Buffer;
}

interface IsolatedGitView {
  readonly arguments: readonly string[];
  readonly dispose: () => Promise<void>;
}

async function readIndex(path: string): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(64 * 1024 * 1024)) {
      throw new GitDiffError(
        "GIT_INPUT_LIMIT_EXCEEDED",
        "Git index exceeds its hard limit",
      );
    }
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== buffer.length ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new GitDiffError(
        "GIT_SOURCE_STALE",
        "Git index changed during copy",
      );
    }
    return buffer;
  } finally {
    await handle?.close();
  }
}

/**
 * Zero per-entry stat fields in a Git index copy so worktree content is always
 * re-examined. Index-file mtime tricks are unreliable across filesystems and can
 * make dirty worktrees look clean; entry-level invalidation keeps staged paths.
 */
function invalidateIndexStatCache(index: Buffer): Buffer {
  const hashSize = 20;
  if (
    index.length < 12 + hashSize ||
    index.subarray(0, 4).toString("latin1") !== "DIRC"
  ) {
    throw new GitDiffError("GIT_UNSAFE_CONFIGURATION", "Git index is invalid");
  }
  const version = index.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new GitDiffError(
      "GIT_UNSAFE_CONFIGURATION",
      "Unsupported Git index version for isolated snapshot collection",
    );
  }
  const entryCount = index.readUInt32BE(8);
  if (entryCount > 1_000_000) {
    throw new GitDiffError(
      "GIT_INPUT_LIMIT_EXCEEDED",
      "Git index entry count exceeds its hard limit",
    );
  }
  const copy = Buffer.from(index);
  let offset = 12;
  for (let entry = 0; entry < entryCount; entry += 1) {
    const entryStart = offset;
    if (entryStart + 40 + hashSize + 2 > copy.length - hashSize) {
      throw new GitDiffError(
        "GIT_UNSAFE_CONFIGURATION",
        "Git index is truncated",
      );
    }
    // ctime, mtime, dev, ino — keep mode at +24, clear uid/gid/size after it.
    copy.fill(0, entryStart, entryStart + 24);
    copy.fill(0, entryStart + 28, entryStart + 40);
    offset = entryStart + 40 + hashSize;
    const flags = copy.readUInt16BE(offset);
    offset += 2;
    if ((flags & 0x4000) !== 0) {
      if (version < 3 || offset + 2 > copy.length - hashSize) {
        throw new GitDiffError(
          "GIT_UNSAFE_CONFIGURATION",
          "Git index extended flags are invalid",
        );
      }
      offset += 2;
    }
    const nameLength = flags & 0x0fff;
    if (nameLength < 0x0fff) {
      offset += nameLength + 1;
    } else {
      const nul = copy.indexOf(0, offset);
      if (nul < 0 || nul >= copy.length - hashSize) {
        throw new GitDiffError(
          "GIT_UNSAFE_CONFIGURATION",
          "Git index path is invalid",
        );
      }
      offset = nul + 1;
    }
    if (offset > copy.length - hashSize) {
      throw new GitDiffError(
        "GIT_UNSAFE_CONFIGURATION",
        "Git index is truncated",
      );
    }
    offset = entryStart + ((offset - entryStart + 7) & ~7);
  }
  const checksumOffset = copy.length - hashSize;
  if (offset > checksumOffset) {
    throw new GitDiffError(
      "GIT_UNSAFE_CONFIGURATION",
      "Git index entry table exceeds the checksum boundary",
    );
  }
  createHash("sha1")
    .update(copy.subarray(0, checksumOffset))
    .digest()
    .copy(copy, checksumOffset);
  return copy;
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) &&
      relation !== ".." &&
      !relation.startsWith(`..${sep}`))
  );
}

async function temporaryGitDirectory(repository: string): Promise<string> {
  const systemTemporaryDirectory = await realpath(tmpdir());
  const base = isContained(repository, systemTemporaryDirectory)
    ? dirname(repository)
    : systemTemporaryDirectory;
  const directory = await mkdtemp(join(base, ".cq-git-view-"));
  if (isContained(repository, directory)) {
    await rm(directory, { force: true, recursive: true });
    throw new GitDiffError(
      "GIT_UNSAFE_CONFIGURATION",
      "An isolated Git view could not be created outside the repository",
    );
  }
  return directory;
}

function repositoryLayout(output: Buffer): {
  readonly index: string;
  readonly objects: string;
} {
  const lines = decodeGitUtf8(output).replace(/\n$/u, "").split("\n");
  const index = lines[0];
  const objects = lines[1];
  if (
    lines.length !== 2 ||
    index === undefined ||
    objects === undefined ||
    !isAbsolute(index) ||
    !isAbsolute(objects) ||
    /[\r\0]/u.test(index) ||
    /[\r\0]/u.test(objects)
  ) {
    throw new GitDiffError(
      "GIT_UNSAFE_CONFIGURATION",
      "Git repository layout is invalid",
    );
  }
  return { index, objects };
}

async function createIsolatedGitView(
  repository: string,
  resolvedHead: string,
  execution: TrustedGitExecution,
  signal?: AbortSignal,
): Promise<IsolatedGitView> {
  const layout = repositoryLayout(
    await gitOutput(
      repository,
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
        "--git-path",
        "objects",
      ],
      16 * 1024,
      execution,
      signal,
    ),
  );
  const objects = await realpath(layout.objects);
  const objectsMetadata = await stat(objects);
  if (!objectsMetadata.isDirectory() || /[\r\n\0]/u.test(objects)) {
    throw new GitDiffError(
      "GIT_UNSAFE_CONFIGURATION",
      "Git object storage is invalid",
    );
  }
  const index = invalidateIndexStatCache(await readIndex(layout.index));
  const directory = await temporaryGitDirectory(repository);
  let complete = false;
  try {
    const objectsInfo = join(directory, "objects", "info");
    await mkdir(objectsInfo, { mode: 0o700, recursive: true });
    const info = join(directory, "info");
    await mkdir(info, { mode: 0o700 });
    await mkdir(join(directory, "refs"), { mode: 0o700 });
    await writeFile(
      join(directory, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    await writeFile(join(directory, "HEAD"), `${resolvedHead}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(directory, "index"), index, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(info, "attributes"), Buffer.alloc(0), {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(objectsInfo, "alternates"), `${objects}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    complete = true;
    let disposed = false;
    return {
      arguments: [`--git-dir=${directory}`, `--work-tree=${repository}`],
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await rm(directory, { force: true, recursive: true });
      },
    };
  } finally {
    if (!complete) await rm(directory, { force: true, recursive: true });
  }
}

function diffArguments(plan: DiffPlan): readonly string[] {
  const options = [
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames=50%",
    "-l400",
    "--abbrev=64",
    "--no-color",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--submodule=short",
    "--ignore-submodules=dirty",
    "--raw",
    "--numstat",
    "--patch",
    "--full-index",
    "-z",
    "--unified=3",
  ];
  if (plan.mode === "root") {
    return [
      "diff-tree",
      "--root",
      "-r",
      "--no-commit-id",
      ...options,
      plan.resolvedHead,
      "--",
    ];
  }
  const revisions =
    plan.mode === "pair"
      ? [plan.comparisonBase ?? "", plan.resolvedHead]
      : [plan.comparisonBase ?? ""];
  return [
    "diff",
    ...(plan.mode === "staged" ? ["--cached"] : []),
    ...options,
    ...revisions,
    "--",
  ];
}

async function gitOutput(
  repository: string,
  args: readonly string[],
  maximumStdoutBytes: number,
  execution: TrustedGitExecution,
  signal?: AbortSignal,
): Promise<Buffer> {
  return (
    await runGitCommand({
      repository,
      args,
      maximumStdoutBytes,
      signal,
      execution,
    })
  ).stdout;
}

async function filterSafety(
  repository: string,
  execution: TrustedGitExecution,
  signal?: AbortSignal,
): Promise<FilterSafety> {
  let configuration: Buffer;
  try {
    configuration = await gitOutput(
      repository,
      [
        "config",
        "--null",
        "--get-regexp",
        "^filter\\..*\\.(clean|process|required)$",
      ],
      64 * 1024,
      execution,
      signal,
    );
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) {
      return EMPTY_FILTER_SAFETY;
    }
    throw error;
  }
  const drivers = new Set<string>();
  let hasExecutable = false;
  for (const token of splitNullRecords(configuration)) {
    const record = decodeGitUtf8(token);
    const separator = record.indexOf("\n");
    if (separator < 1)
      throw new GitDiffError(
        "GIT_INPUT_LIMIT_EXCEEDED",
        "Invalid filter config",
      );
    const match = /^filter\.(.+)\.(clean|process|required)$/u.exec(
      record.slice(0, separator),
    );
    const driver = match?.[1];
    const property = match?.[2];
    if (driver === undefined || property === undefined) continue;
    drivers.add(driver);
    const value = record.slice(separator + 1);
    if ((property === "clean" || property === "process") && value.length > 0) {
      hasExecutable = true;
    }
  }
  if (
    drivers.size > MAX_FILTER_DRIVERS ||
    [...drivers].some((driver) => !FILTER_DRIVER.test(driver))
  ) {
    throw new GitDiffError(
      "GIT_INPUT_LIMIT_EXCEEDED",
      "Configured Git filter drivers exceed their safety limit",
    );
  }
  return {
    hasExecutable,
    identity: Buffer.from(configuration),
  };
}

async function verifyFilterSafety(
  repository: string,
  expected: FilterSafety,
  execution: TrustedGitExecution,
  signal?: AbortSignal,
): Promise<void> {
  const current = await filterSafety(repository, execution, signal);
  if (!current.identity.equals(expected.identity)) {
    if (!expected.hasExecutable && current.hasExecutable) {
      throw new GitDiffError(
        "GIT_UNSAFE_CONFIGURATION",
        "Executable Git filter configuration appeared during collection",
      );
    }
    throw new GitDiffError(
      "GIT_SOURCE_STALE",
      "Git filter configuration changed during snapshot collection",
    );
  }
}

async function effectiveAttributes(
  repository: string,
  files: readonly SnapshotFile[],
  isolatedArguments: readonly string[],
  execution: TrustedGitExecution,
  signal?: AbortSignal,
): Promise<Buffer> {
  const paths = [
    ...new Set(
      files.flatMap((file) => [
        ...(file.previousPath === undefined ? [] : [file.previousPath]),
        file.path,
      ]),
    ),
  ];
  if (paths.length === 0) return Buffer.alloc(0);
  return gitOutput(
    repository,
    [...isolatedArguments, "check-attr", "-z", "--all", "--", ...paths],
    MAX_METADATA_BYTES,
    execution,
    signal,
  );
}

export async function collectDiffMaterial(
  repository: string,
  plan: DiffPlan,
  io: DiffCollectionIo,
  execution: TrustedGitExecution,
  signal?: AbortSignal,
): Promise<CapturedMaterial> {
  let filters = EMPTY_FILTER_SAFETY;
  if (plan.kind === "worktree")
    filters = await filterSafety(repository, execution, signal);
  const isolated =
    plan.kind === "worktree"
      ? await createIsolatedGitView(
          repository,
          plan.resolvedHead,
          execution,
          signal,
        )
      : undefined;
  try {
    const isolatedArguments = isolated?.arguments ?? [];
    const args = [...isolatedArguments, ...diffArguments(plan)];
    await io.beforeDiffCommand?.(args);
    if (plan.kind === "worktree") {
      await verifyFilterSafety(repository, filters, execution, signal);
    }
    await io.afterFilterVerificationBeforeSpawn?.();
    const output = await gitOutput(
      repository,
      args,
      MAX_SNAPSHOT_DIFF_BYTES + 2 * MAX_METADATA_BYTES,
      execution,
      signal,
    );
    const envelope = parseGitDiffEnvelope(output);
    if (
      envelope.raw.length > MAX_METADATA_BYTES ||
      envelope.numstat.length > MAX_METADATA_BYTES ||
      envelope.patch.length > MAX_SNAPSHOT_DIFF_BYTES
    ) {
      throw new GitDiffError(
        "GIT_INPUT_LIMIT_EXCEEDED",
        "Git diff envelope exceeds its hard limits",
      );
    }
    if (plan.kind === "worktree") {
      await verifyFilterSafety(repository, filters, execution, signal);
    }
    const attributes =
      plan.kind === "worktree"
        ? await effectiveAttributes(
            repository,
            envelope.files,
            isolatedArguments,
            execution,
            signal,
          )
        : Buffer.alloc(0);
    if (plan.kind !== "worktree") {
      return {
        attributes,
        filterConfig: filters.identity,
        raw: envelope.raw,
        numstat: envelope.numstat,
        patch: envelope.patch,
      };
    }
    const status = await gitOutput(
      repository,
      [
        ...isolatedArguments,
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
      ],
      MAX_METADATA_BYTES,
      execution,
      signal,
    );
    await verifyFilterSafety(repository, filters, execution, signal);
    const untracked = await gitOutput(
      repository,
      [
        ...isolatedArguments,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
      ],
      MAX_METADATA_BYTES,
      execution,
      signal,
    );
    return {
      attributes,
      filterConfig: filters.identity,
      raw: envelope.raw,
      numstat: envelope.numstat,
      patch: envelope.patch,
      status,
      untracked,
    };
  } finally {
    await isolated?.dispose();
  }
}

export function hashCapturedMaterial(material: CapturedMaterial): string {
  return hashSnapshotParts([
    material.attributes,
    material.filterConfig,
    material.raw,
    material.numstat,
    material.patch,
    material.status,
    material.untracked,
  ]);
}
