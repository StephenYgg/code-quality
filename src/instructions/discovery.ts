import type { Dir } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import {
  AGENT_DOCUMENT_RULE_ID,
  type ValidationDiagnostic,
} from "../core/validation.js";
import {
  BoundedDiagnosticCollector,
  DEFAULT_MAX_DIAGNOSTICS,
  HARD_MAX_DIAGNOSTICS,
} from "../core/bounded-diagnostics.js";
import {
  BoundedMinPriorityQueue,
  retainSmallest,
} from "../core/bounded-selection.js";

const CANONICAL_FILE_NAME = "AGENTS.md";
const DEFAULT_PEER_FILE_NAMES = ["CLAUDE.md", "GEMINI.md"] as const;
const DEFAULT_MAX_DIRECTORIES = 20_000;
const DEFAULT_MAX_INSTRUCTION_FILES = 5_000;
const DEFAULT_MAX_ENTRIES = 200_000;
const HARD_MAX_DIRECTORIES = 100_000;
const HARD_MAX_INSTRUCTION_FILES = 20_000;
const HARD_MAX_ENTRIES = 1_000_000;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

export interface InstructionFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly name: string;
  readonly symbolicLink: boolean;
}

export interface InstructionScope {
  readonly directory: string;
  readonly canonical?: InstructionFile;
  readonly peers: readonly InstructionFile[];
}

export interface DiscoveryOptions {
  readonly peerFileNames?: readonly string[];
  readonly maxDirectories?: number;
  readonly maxInstructionFiles?: number;
  readonly maxEntries?: number;
  readonly maxDiagnostics?: number;
}

export interface DiscoveryResult {
  readonly repository: string;
  readonly scopes: readonly InstructionScope[];
  readonly diagnostics: readonly ValidationDiagnostic[];
}

interface MutableInstructionScope {
  canonical?: InstructionFile;
  peers: InstructionFile[];
}

interface PendingDirectory {
  readonly absolutePath: string;
  readonly relativePath: string;
}

interface PendingInstructionFile extends RelativePathItem {
  readonly directory: string;
  readonly file: InstructionFile;
}

interface RelativePathItem {
  readonly relativePath: string;
}

interface DiscoveryLimits {
  readonly maxDirectories: number;
  readonly maxInstructionFiles: number;
  readonly maxEntries: number;
  readonly maxDiagnostics: number;
}

export interface DirectoryIdentity {
  readonly realPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly changeTime: bigint;
}

interface ScanDirectoryOptions {
  readonly directory: string;
  readonly entryBudget: { count: number };
  readonly limits: DiscoveryLimits;
  readonly recognizedFileNames: ReadonlySet<string>;
  readonly remainingDirectories: number;
  readonly maximumInstructionFiles: number;
  readonly repository: string;
}

interface DirectoryScanResult {
  readonly discoveredDirectories: PendingDirectory[];
  readonly entryLimitExceeded: boolean;
  readonly omittedDirectoryPath: string | undefined;
  readonly omittedInstructionPath: string | undefined;
  readonly pendingFiles: InstructionFile[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRelativePathItems(
  left: RelativePathItem,
  right: RelativePathItem,
): number {
  return compareText(left.relativePath, right.relativePath);
}

function earlierPath(current: string | undefined, candidate: string): string {
  return current === undefined || compareText(candidate, current) < 0
    ? candidate
    : current;
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function toRelativePath(repository: string, absolutePath: string): string {
  const result = toPosixPath(relative(repository, absolutePath));
  return result === "" ? "." : result;
}

function isInsideRepository(repository: string, target: string): boolean {
  const relativePath = relative(repository, target);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))
  );
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  if (resolved > hardMaximum) {
    throw new TypeError(`${label} cannot exceed ${String(hardMaximum)}`);
  }
  return resolved;
}

function peerFileNames(configured: readonly string[] | undefined): Set<string> {
  const names = new Set<string>(DEFAULT_PEER_FILE_NAMES);
  for (const name of configured ?? []) {
    if (
      basename(name) !== name ||
      !name.endsWith(".md") ||
      name === CANONICAL_FILE_NAME
    ) {
      throw new TypeError(
        `Peer instruction filename must be a Markdown basename other than ${CANONICAL_FILE_NAME}: ${name}`,
      );
    }
    names.add(name);
  }
  return names;
}

async function resolveRepositoryRoot(repositoryPath: string): Promise<string> {
  const requestedRepository = resolve(repositoryPath);
  try {
    const repository = await realpath(requestedRepository);
    const repositoryStat = await stat(repository);
    if (!repositoryStat.isDirectory()) {
      throw new TypeError(
        `Repository path must be a directory: ${repositoryPath}`,
      );
    }
    return repository;
  } catch (error) {
    if (error instanceof TypeError) {
      throw error;
    }
    throw new TypeError(
      `Repository path must be a readable directory: ${repositoryPath}`,
    );
  }
}

function resolveDiscoveryLimits(options: DiscoveryOptions): DiscoveryLimits {
  return {
    maxDirectories: boundedPositiveInteger(
      options.maxDirectories,
      DEFAULT_MAX_DIRECTORIES,
      HARD_MAX_DIRECTORIES,
      "Directory scan limit",
    ),
    maxInstructionFiles: boundedPositiveInteger(
      options.maxInstructionFiles,
      DEFAULT_MAX_INSTRUCTION_FILES,
      HARD_MAX_INSTRUCTION_FILES,
      "Instruction file scan limit",
    ),
    maxEntries: boundedPositiveInteger(
      options.maxEntries,
      DEFAULT_MAX_ENTRIES,
      HARD_MAX_ENTRIES,
      "Directory entry scan limit",
    ),
    maxDiagnostics: boundedPositiveInteger(
      options.maxDiagnostics,
      DEFAULT_MAX_DIAGNOSTICS,
      HARD_MAX_DIAGNOSTICS,
      "Diagnostic limit",
    ),
  };
}

export async function captureDirectoryIdentity(
  repository: string,
  directory: string,
): Promise<DirectoryIdentity> {
  const currentRealPath = await realpath(directory);
  if (
    currentRealPath !== directory ||
    !isInsideRepository(repository, currentRealPath)
  ) {
    throw new Error(
      "Directory resolves through a symlink or outside repository",
    );
  }
  const currentStat = await stat(currentRealPath, { bigint: true });
  if (!currentStat.isDirectory()) {
    throw new Error("Directory target is not a directory");
  }
  return {
    realPath: currentRealPath,
    device: currentStat.dev,
    inode: currentStat.ino,
    changeTime: currentStat.ctimeNs,
  };
}

async function openVerifiedDirectory(
  repository: string,
  directory: string,
): Promise<{ readonly handle: Dir; readonly identity: DirectoryIdentity }> {
  const identity = await captureDirectoryIdentity(repository, directory);
  const handle = await opendir(directory);
  try {
    const openedIdentity = await captureDirectoryIdentity(
      repository,
      directory,
    );
    if (
      openedIdentity.realPath !== identity.realPath ||
      openedIdentity.device !== identity.device ||
      openedIdentity.inode !== identity.inode ||
      openedIdentity.changeTime !== identity.changeTime
    ) {
      throw new Error("Directory changed while it was opened");
    }
    return { handle, identity };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function verifyDirectoryUnchanged(
  repository: string,
  directory: string,
  identity: DirectoryIdentity,
): Promise<void> {
  const current = await captureDirectoryIdentity(repository, directory);
  if (
    current.realPath !== identity.realPath ||
    current.device !== identity.device ||
    current.inode !== identity.inode ||
    current.changeTime !== identity.changeTime
  ) {
    throw new Error("Directory changed during instruction discovery");
  }
}

function scanDiagnostic(
  code: "SCAN_FAILED" | "SCAN_LIMIT_EXCEEDED",
  path: string,
  message: string,
): ValidationDiagnostic {
  return {
    ruleId: AGENT_DOCUMENT_RULE_ID,
    code,
    category: "incomplete",
    certainty: "deterministic",
    path,
    message,
  };
}

function shouldSkipDirectory(relativePath: string, name: string): boolean {
  return (
    SKIPPED_DIRECTORIES.has(name) ||
    relativePath === ".code-quality/cache" ||
    relativePath.startsWith(".code-quality/cache/")
  );
}

function addInstructionFile(
  scopes: Map<string, MutableInstructionScope>,
  directory: string,
  file: InstructionFile,
): void {
  const scope = scopes.get(directory) ?? { peers: [] };
  if (file.name === CANONICAL_FILE_NAME) {
    scope.canonical = file;
  } else {
    scope.peers.push(file);
  }
  scopes.set(directory, scope);
}

function sortedInstructionScopes(
  scopes: Map<string, MutableInstructionScope>,
): InstructionScope[] {
  return [...scopes.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([directory, scope]) => {
      scope.peers.sort((left, right) =>
        compareText(left.relativePath, right.relativePath),
      );
      return scope.canonical === undefined
        ? { directory, peers: scope.peers }
        : { directory, canonical: scope.canonical, peers: scope.peers };
    });
}

function retainInstructionFiles(
  selectedFiles: BoundedMinPriorityQueue<PendingInstructionFile>,
  directory: string,
  files: readonly InstructionFile[],
  initialOmittedPath: string | undefined,
  locallyOmittedPath: string | undefined,
): string | undefined {
  let omittedPath =
    locallyOmittedPath === undefined
      ? initialOmittedPath
      : earlierPath(initialOmittedPath, locallyOmittedPath);
  for (const file of files) {
    const omitted = selectedFiles.retain({
      directory,
      file,
      relativePath: file.relativePath,
    });
    if (omitted !== undefined) {
      omittedPath = earlierPath(omittedPath, omitted.relativePath);
    }
  }
  return omittedPath;
}

async function scanDirectory({
  directory,
  entryBudget,
  limits,
  recognizedFileNames,
  remainingDirectories,
  maximumInstructionFiles,
  repository,
}: ScanDirectoryOptions): Promise<DirectoryScanResult> {
  const discoveredDirectories: PendingDirectory[] = [];
  const pendingFiles: InstructionFile[] = [];
  let entryLimitExceeded = false;
  let omittedDirectoryPath: string | undefined;
  let omittedInstructionPath: string | undefined;
  const { handle, identity } = await openVerifiedDirectory(
    repository,
    directory,
  );
  for await (const entry of handle) {
    if (entryBudget.count >= limits.maxEntries) {
      entryLimitExceeded = true;
      break;
    }
    entryBudget.count += 1;
    const absolutePath = resolve(directory, entry.name);
    const relativePath = toRelativePath(repository, absolutePath);

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(relativePath, entry.name)) {
        continue;
      }
      const omitted = retainSmallest(
        discoveredDirectories,
        { absolutePath, relativePath },
        remainingDirectories,
        compareRelativePathItems,
      );
      if (omitted !== undefined) {
        omittedDirectoryPath = earlierPath(
          omittedDirectoryPath,
          omitted.relativePath,
        );
      }
      continue;
    }

    if (
      !recognizedFileNames.has(entry.name) ||
      (!entry.isFile() && !entry.isSymbolicLink())
    ) {
      continue;
    }
    const omitted = retainSmallest(
      pendingFiles,
      {
        absolutePath,
        relativePath,
        name: entry.name,
        symbolicLink: entry.isSymbolicLink(),
      },
      maximumInstructionFiles,
      compareRelativePathItems,
    );
    if (omitted !== undefined) {
      omittedInstructionPath = earlierPath(
        omittedInstructionPath,
        omitted.relativePath,
      );
    }
  }
  await verifyDirectoryUnchanged(repository, directory, identity);
  return {
    discoveredDirectories,
    entryLimitExceeded,
    omittedDirectoryPath,
    omittedInstructionPath,
    pendingFiles,
  };
}

export async function discoverInstructionScopes(
  repositoryPath: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const repository = await resolveRepositoryRoot(repositoryPath);
  const peers = peerFileNames(options.peerFileNames);
  const recognizedFileNames = new Set([CANONICAL_FILE_NAME, ...peers]);
  const limits = resolveDiscoveryLimits(options);

  const pendingDirectories = new BoundedMinPriorityQueue<PendingDirectory>(
    limits.maxDirectories,
    compareRelativePathItems,
  );
  pendingDirectories.retain({ absolutePath: repository, relativePath: "." });
  const selectedInstructionFiles =
    new BoundedMinPriorityQueue<PendingInstructionFile>(
      limits.maxInstructionFiles,
      compareRelativePathItems,
    );
  const scopes = new Map<string, MutableInstructionScope>();
  const diagnostics = new BoundedDiagnosticCollector(limits.maxDiagnostics);
  const entryBudget = { count: 0 };
  let scannedDirectoryCount = 0;
  let entryLimitPath: string | undefined;
  let omittedDirectoryPath: string | undefined;
  let omittedInstructionPath: string | undefined;

  while (pendingDirectories.size > 0) {
    const pendingDirectory = pendingDirectories.popMinimum();
    if (pendingDirectory === undefined) {
      break;
    }
    scannedDirectoryCount += 1;
    for (const omitted of pendingDirectories.setMaximum(
      limits.maxDirectories - scannedDirectoryCount,
    )) {
      omittedDirectoryPath = earlierPath(
        omittedDirectoryPath,
        omitted.relativePath,
      );
    }
    const directory = pendingDirectory.absolutePath;
    const relativeDirectory = toRelativePath(repository, directory);
    const remainingDirectories = Math.max(
      0,
      limits.maxDirectories - scannedDirectoryCount,
    );

    let scan: DirectoryScanResult;
    try {
      scan = await scanDirectory({
        directory,
        entryBudget,
        limits,
        maximumInstructionFiles: limits.maxInstructionFiles,
        recognizedFileNames,
        remainingDirectories,
        repository,
      });
    } catch {
      diagnostics.add(
        scanDiagnostic(
          "SCAN_FAILED",
          relativeDirectory,
          "Directory could not be read during instruction discovery",
        ),
      );
      continue;
    }

    if (scan.entryLimitExceeded) {
      entryLimitPath = relativeDirectory;
      break;
    }

    if (scan.omittedDirectoryPath !== undefined) {
      omittedDirectoryPath = earlierPath(
        omittedDirectoryPath,
        scan.omittedDirectoryPath,
      );
    }
    scan.discoveredDirectories.sort(compareRelativePathItems);
    for (const discoveredDirectory of scan.discoveredDirectories) {
      const omitted = pendingDirectories.retain(discoveredDirectory);
      if (omitted !== undefined) {
        omittedDirectoryPath = earlierPath(
          omittedDirectoryPath,
          omitted.relativePath,
        );
      }
    }

    omittedInstructionPath = retainInstructionFiles(
      selectedInstructionFiles,
      relativeDirectory,
      scan.pendingFiles,
      omittedInstructionPath,
      scan.omittedInstructionPath,
    );
  }

  if (entryLimitPath !== undefined) {
    return {
      repository,
      scopes: [],
      diagnostics: [
        scanDiagnostic(
          "SCAN_LIMIT_EXCEEDED",
          entryLimitPath,
          `Directory entry scan limit of ${String(limits.maxEntries)} was exceeded; partial scope evidence was discarded`,
        ),
      ],
    };
  }

  if (omittedDirectoryPath !== undefined) {
    diagnostics.add(
      scanDiagnostic(
        "SCAN_LIMIT_EXCEEDED",
        omittedDirectoryPath,
        `Directory scan limit of ${String(limits.maxDirectories)} was exceeded`,
      ),
    );
  }
  if (omittedInstructionPath !== undefined) {
    diagnostics.add(
      scanDiagnostic(
        "SCAN_LIMIT_EXCEEDED",
        omittedInstructionPath,
        `Instruction file limit of ${String(limits.maxInstructionFiles)} was exceeded`,
      ),
    );
  }
  while (selectedInstructionFiles.size > 0) {
    const selected = selectedInstructionFiles.popMinimum();
    if (selected === undefined) {
      break;
    }
    addInstructionFile(scopes, selected.directory, selected.file);
  }

  return {
    repository,
    scopes: sortedInstructionScopes(scopes),
    diagnostics: diagnostics.toArray(),
  };
}
