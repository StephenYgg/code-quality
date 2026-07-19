import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { compareCodeUnits } from "../core/deterministic-order.js";
import {
  createReviewSnapshot,
  decodeGitUtf8,
  hashSnapshotParts,
  MAX_SNAPSHOT_PATH_BYTES,
  splitNullRecords,
  type ReviewSnapshot,
  type SnapshotExclusion,
  type SnapshotExclusionReason,
  type SnapshotFile,
} from "../core/snapshots.js";
import {
  resolveTrustedGitExecution,
  runGitCommand,
  type TrustedGitExecution,
} from "./commands.js";
import { resolveCommit, resolveGitRepository } from "./repository.js";

export const DEFAULT_REPOSITORY_FILE_LIMIT = 5_000;
export const DEFAULT_REPOSITORY_BYTE_LIMIT = 50 * 1024 * 1024;
export const DEFAULT_REPOSITORY_ENTRY_LIMIT = 20_000;
export const DEFAULT_REPOSITORY_INDIVIDUAL_FILE_BYTES = 1 * 1024 * 1024;
export const MAX_REPOSITORY_FILE_LIMIT = 5_000;
export const MAX_REPOSITORY_BYTE_LIMIT = 50 * 1024 * 1024;
export const MAX_EXCLUSION_SAMPLES_PER_REASON = 20;

const DEPENDENCY_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  ".pnpm-store",
  "bower_components",
]);
const GENERATED_SEGMENTS = new Set([
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
]);
const CACHE_SEGMENTS = new Set([
  ".cache",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wasm",
  ".bin",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".jar",
  ".pyc",
]);
const SECRET_PATH_MARKERS = [
  ".env",
  "id_rsa",
  "id_ed25519",
  ".pem",
  ".p12",
  ".pfx",
  "credentials",
  "secrets",
];
const SECRET_CONTENT = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}/iu,
];

export class RepositoryManifestError extends Error {
  constructor(
    readonly code:
      | "REPOSITORY_SELECTOR_INVALID"
      | "REPOSITORY_LIMIT_EXCEEDED"
      | "REPOSITORY_CONFIRMATION_MISMATCH"
      | "REPOSITORY_SOURCE_STALE"
      | "REPOSITORY_UNSAFE",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryManifestError";
  }
}

export interface RepositoryManifestLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly maxIndividualFileBytes: number;
}

export interface RepositoryManifestContext {
  readonly policyHash: string;
  readonly providerClass: string;
  readonly endpointClass: string;
  readonly egressClass: string;
  readonly budgets: {
    readonly maxTokens: number;
    readonly maxDurationMs: number;
    readonly maxCostUsd: number;
  };
}

export interface RepositoryFileContent {
  readonly path: string;
  readonly tracked: boolean;
  readonly size: number;
  readonly contentHash: string;
  readonly bytes: Buffer;
}

export interface RepositoryCapture {
  readonly repository: string;
  readonly head: string;
  readonly trackedCount: number;
  readonly untrackedCount: number;
  readonly selected: readonly RepositoryFileContent[];
  readonly exclusions: readonly SnapshotExclusion[];
  readonly incomplete: boolean;
  readonly limits: RepositoryManifestLimits;
  readonly contentHash: string;
  readonly confirmationHash: string;
}

export interface RepositoryPreflight {
  readonly repository: string;
  readonly head: string;
  readonly trackedCount: number;
  readonly untrackedCount: number;
  readonly selectedFileCount: number;
  readonly selectedByteCount: number;
  readonly exclusions: readonly SnapshotExclusion[];
  readonly exclusionCounts: Readonly<Record<string, number>>;
  readonly incomplete: boolean;
  readonly limits: RepositoryManifestLimits;
  readonly providerClass: string;
  readonly endpointClass: string;
  readonly egressClass: string;
  readonly budgets: RepositoryManifestContext["budgets"];
  readonly policyHash: string;
  readonly contentHash: string;
  readonly confirmationHash: string;
}

function defaultLimits(
  overrides?: Partial<RepositoryManifestLimits>,
): RepositoryManifestLimits {
  const maxFiles = overrides?.maxFiles ?? DEFAULT_REPOSITORY_FILE_LIMIT;
  const maxBytes = overrides?.maxBytes ?? DEFAULT_REPOSITORY_BYTE_LIMIT;
  const maxEntries = overrides?.maxEntries ?? DEFAULT_REPOSITORY_ENTRY_LIMIT;
  const maxIndividualFileBytes =
    overrides?.maxIndividualFileBytes ??
    DEFAULT_REPOSITORY_INDIVIDUAL_FILE_BYTES;
  for (const [name, value, maximum] of [
    ["maxFiles", maxFiles, MAX_REPOSITORY_FILE_LIMIT],
    ["maxBytes", maxBytes, MAX_REPOSITORY_BYTE_LIMIT],
    ["maxEntries", maxEntries, DEFAULT_REPOSITORY_ENTRY_LIMIT],
    [
      "maxIndividualFileBytes",
      maxIndividualFileBytes,
      DEFAULT_REPOSITORY_INDIVIDUAL_FILE_BYTES,
    ],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new RepositoryManifestError(
        "REPOSITORY_LIMIT_EXCEEDED",
        `${name} is outside its hard limit`,
      );
    }
  }
  return { maxFiles, maxBytes, maxEntries, maxIndividualFileBytes };
}

function validatePath(path: string): string | undefined {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\0") ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    ) ||
    Buffer.byteLength(path, "utf8") > MAX_SNAPSHOT_PATH_BYTES
  ) {
    return undefined;
  }
  return path;
}

function pathSegments(path: string): readonly string[] {
  return path.split("/");
}

function classifyPath(path: string): SnapshotExclusionReason | undefined {
  const lower = path.toLowerCase();
  const segments = pathSegments(path);
  if (segments[0] === ".git" || segments.includes(".git"))
    return "git_metadata";
  if (segments.some((segment) => DEPENDENCY_SEGMENTS.has(segment))) {
    return "dependency";
  }
  if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) {
    return "generated";
  }
  if (segments.some((segment) => CACHE_SEGMENTS.has(segment))) return "cache";
  if (SECRET_PATH_MARKERS.some((marker) => lower.includes(marker))) {
    return "suspected_secret";
  }
  const extension = lower.includes(".")
    ? lower.slice(lower.lastIndexOf("."))
    : "";
  if (BINARY_EXTENSIONS.has(extension)) return "binary";
  return undefined;
}

function isBinaryContent(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

function looksLikeSecret(buffer: Buffer): boolean {
  let text: string;
  try {
    text = buffer.toString("utf8");
  } catch {
    return false;
  }
  return SECRET_CONTENT.some((pattern) => pattern.test(text));
}

async function gitNullPaths(
  repository: string,
  args: readonly string[],
  execution: TrustedGitExecution,
  signal?: AbortSignal,
  maximumStdoutBytes = 8 * 1024 * 1024,
): Promise<readonly string[]> {
  const result = await runGitCommand({
    repository,
    args,
    execution,
    signal,
    maximumStdoutBytes,
  });
  if (result.stdout.length === 0) return [];
  return splitNullRecords(result.stdout).map((token) => decodeGitUtf8(token));
}

async function readPathBytes(
  repository: string,
  relativePath: string,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: SnapshotExclusionReason }
> {
  const absolute = `${repository}${sep}${relativePath.split("/").join(sep)}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (before.isSymbolicLink() || before.isDirectory()) {
      return { ok: false, reason: "symlink" };
    }
    if (!before.isFile()) {
      return { ok: false, reason: "unsupported_type" };
    }
    if (before.size > BigInt(maxBytes)) {
      return { ok: false, reason: "file_limit" };
    }
    const size = Number(before.size);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = await handle.read(buffer, offset, size - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      return { ok: false, reason: "read_or_identity_error" };
    }
    return { ok: true, bytes: buffer };
  } catch {
    return { ok: false, reason: "read_or_identity_error" };
  } finally {
    await handle?.close();
  }
}

function pushExclusion(
  exclusions: SnapshotExclusion[],
  counts: Map<string, number>,
  samples: Map<string, number>,
  reason: SnapshotExclusionReason,
  path?: string,
): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const sampleCount = samples.get(reason) ?? 0;
  if (sampleCount < MAX_EXCLUSION_SAMPLES_PER_REASON) {
    exclusions.push(path === undefined ? { reason } : { reason, path });
    samples.set(reason, sampleCount + 1);
  }
}

function hashCapture(
  head: string,
  selected: readonly RepositoryFileContent[],
  exclusions: readonly SnapshotExclusion[],
  limits: RepositoryManifestLimits,
): string {
  const parts: Buffer[] = [
    Buffer.from(head, "utf8"),
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

function confirmationHash(
  contentHash: string,
  context: RepositoryManifestContext,
): string {
  return createHash("sha256")
    .update("cq-repository-confirm:v1\0")
    .update(contentHash)
    .update("\0")
    .update(context.policyHash)
    .update("\0")
    .update(context.providerClass)
    .update("\0")
    .update(context.endpointClass)
    .update("\0")
    .update(context.egressClass)
    .update("\0")
    .update(String(context.budgets.maxTokens))
    .update("\0")
    .update(String(context.budgets.maxDurationMs))
    .update("\0")
    .update(String(context.budgets.maxCostUsd))
    .digest("hex");
}

export async function collectRepositoryManifest(
  request: {
    readonly repository: string;
    readonly signal?: AbortSignal;
  },
  context: RepositoryManifestContext,
  limitOverrides?: Partial<RepositoryManifestLimits>,
): Promise<RepositoryCapture> {
  const limits = defaultLimits(limitOverrides);
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

  const tracked = await gitNullPaths(
    repository,
    ["ls-files", "-z", "--"],
    execution,
    request.signal,
  );
  const untracked = await gitNullPaths(
    repository,
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    execution,
    request.signal,
  );
  const ignored = await gitNullPaths(
    repository,
    ["ls-files", "--others", "-i", "--exclude-standard", "-z", "--"],
    execution,
    request.signal,
    2 * 1024 * 1024,
  );

  const exclusions: SnapshotExclusion[] = [];
  const counts = new Map<string, number>();
  const samples = new Map<string, number>();
  let incomplete = false;

  for (const path of ignored) {
    pushExclusion(exclusions, counts, samples, "git_ignored", path);
  }

  const candidates: { readonly path: string; readonly tracked: boolean }[] = [];
  for (const [paths, trackedFlag] of [
    [tracked, true],
    [untracked, false],
  ] as const) {
    for (const rawPath of paths) {
      if (candidates.length + exclusions.length > limits.maxEntries) {
        incomplete = true;
        pushExclusion(exclusions, counts, samples, "entry_limit");
        break;
      }
      const path = validatePath(rawPath);
      if (path === undefined) {
        incomplete = true;
        pushExclusion(exclusions, counts, samples, "path_limit", rawPath);
        continue;
      }
      const classified = classifyPath(path);
      if (classified !== undefined) {
        pushExclusion(exclusions, counts, samples, classified, path);
        continue;
      }
      candidates.push({ path, tracked: trackedFlag });
    }
  }

  candidates.sort((left, right) => compareCodeUnits(left.path, right.path));

  const selected: RepositoryFileContent[] = [];
  let selectedBytes = 0;
  for (const candidate of candidates) {
    if (selected.length >= limits.maxFiles) {
      incomplete = true;
      pushExclusion(
        exclusions,
        counts,
        samples,
        "aggregate_file_limit",
        candidate.path,
      );
      continue;
    }
    const read = await readPathBytes(
      repository,
      candidate.path,
      limits.maxIndividualFileBytes,
    );
    if (!read.ok) {
      if (
        read.reason === "file_limit" ||
        read.reason === "read_or_identity_error"
      ) {
        incomplete = true;
      }
      pushExclusion(exclusions, counts, samples, read.reason, candidate.path);
      continue;
    }
    if (selectedBytes + read.bytes.length > limits.maxBytes) {
      incomplete = true;
      pushExclusion(
        exclusions,
        counts,
        samples,
        "aggregate_byte_limit",
        candidate.path,
      );
      continue;
    }
    if (isBinaryContent(read.bytes)) {
      pushExclusion(exclusions, counts, samples, "binary", candidate.path);
      continue;
    }
    if (looksLikeSecret(read.bytes)) {
      pushExclusion(
        exclusions,
        counts,
        samples,
        "suspected_secret",
        candidate.path,
      );
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
    selectedBytes += read.bytes.length;
  }

  const contentHash = hashCapture(head, selected, exclusions, limits);
  const confirm = confirmationHash(contentHash, context);
  return {
    repository,
    head,
    trackedCount: tracked.length,
    untrackedCount: untracked.length,
    selected: Object.freeze(selected.map((file) => Object.freeze(file))),
    exclusions: Object.freeze(exclusions.map((item) => Object.freeze(item))),
    incomplete,
    limits,
    contentHash,
    confirmationHash: confirm,
  };
}

export function createRepositoryPreflight(
  capture: RepositoryCapture,
  context: RepositoryManifestContext,
): RepositoryPreflight {
  const exclusionCounts: Record<string, number> = {};
  for (const exclusion of capture.exclusions) {
    exclusionCounts[exclusion.reason] =
      (exclusionCounts[exclusion.reason] ?? 0) + 1;
  }
  const selectedByteCount = capture.selected.reduce(
    (total, file) => total + file.size,
    0,
  );
  return Object.freeze({
    repository: capture.repository,
    head: capture.head,
    trackedCount: capture.trackedCount,
    untrackedCount: capture.untrackedCount,
    selectedFileCount: capture.selected.length,
    selectedByteCount,
    exclusions: capture.exclusions,
    exclusionCounts: Object.freeze(exclusionCounts),
    incomplete: capture.incomplete,
    limits: capture.limits,
    providerClass: context.providerClass,
    endpointClass: context.endpointClass,
    egressClass: context.egressClass,
    budgets: context.budgets,
    policyHash: context.policyHash,
    contentHash: capture.contentHash,
    confirmationHash: capture.confirmationHash,
  });
}

export async function reconfirmRepository(
  expectedConfirmationHash: string,
  request: { readonly repository: string; readonly signal?: AbortSignal },
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
  if (capture.confirmationHash !== expectedConfirmationHash) {
    throw new RepositoryManifestError(
      "REPOSITORY_CONFIRMATION_MISMATCH",
      "Full-repository confirmation hash does not match the current manifest",
    );
  }
  return capture;
}

export function repositoryCaptureToSnapshot(
  capture: RepositoryCapture,
): ReviewSnapshot {
  // Snapshot interchange is intentionally bounded; the full capture retains bytes.
  const maxFiles = 200;
  const maxExclusions = 400;
  const files: SnapshotFile[] = capture.selected
    .slice(0, maxFiles)
    .map((file) => ({
      path: file.path,
      status: "modified" as const,
      binary: false,
    }));
  const truncated =
    capture.selected.length > maxFiles ||
    capture.exclusions.length > maxExclusions;
  return createReviewSnapshot({
    inputKind: "repository",
    scope: "repository",
    repository: capture.repository,
    head: createHash("sha256")
      .update("repository:")
      .update(capture.head)
      .update(":")
      .update(capture.contentHash)
      .digest("hex"),
    files,
    exclusions: capture.exclusions.slice(0, maxExclusions),
    incomplete: capture.incomplete || truncated,
  });
}

export function isPathInsideRepository(
  repository: string,
  candidate: string,
): boolean {
  const relation = relative(repository, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) &&
      relation !== ".." &&
      !relation.startsWith(`..${sep}`))
  );
}
