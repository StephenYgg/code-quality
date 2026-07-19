import { constants, type BigIntStats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  StructuredConfigError,
  loadStructuredFile,
  type StructuredReadBudget,
} from "./config.js";
import { compareCodeUnits } from "./deterministic-order.js";
import { PolicyDiagnosticCollector } from "./policy-diagnostics.js";
import { configDiagnostic } from "./policy-schema.js";
import type { PolicyDiagnostic, PolicySource } from "./policy-types.js";
import { filePolicySource } from "./policy-values.js";
import {
  readStableDirectoryEntries,
  type OpenedWaiverDirectory,
  type WaiverDirectorySnapshotIo,
} from "./waiver-directory-snapshot.js";
import {
  MAX_WAIVERS_PER_MATCH,
  validateWaiverInputs,
  type Waiver,
} from "./waivers.js";

export const MAX_WAIVER_DIRECTORY_ENTRIES = 2_000;

export interface WaiverDiscoveryIo extends WaiverDirectorySnapshotIo {
  openDirectoryHandle?(path: string, flags: number): Promise<FileHandle>;
  realpath(path: string): Promise<string>;
  beforeDirectoryEnumeration?(requestedPath: string): Promise<void>;
}

export type { OpenedWaiverDirectory };

const DEFAULT_DISCOVERY_IO: WaiverDiscoveryIo = {
  realpath,
  stat: async (path) => stat(path, { bigint: true }),
};

interface WaiverCandidate {
  readonly path: string;
  readonly source: string;
}

interface DirectoryEntryBudget {
  inspectedEntries: number;
}

export interface DiscoveredWaivers {
  readonly waivers: readonly Waiver[];
  readonly diagnostics: readonly PolicyDiagnostic[];
  readonly sources: readonly PolicySource[];
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

function isWaiverFile(path: string): boolean {
  return /\.(?:json|ya?ml)$/u.test(path);
}

function sourcePath(repository: string, path: string): string {
  return relative(repository, path).replaceAll("\\", "/");
}

function locationDiagnostic(
  code: string,
  source: string,
  message: string,
): PolicyDiagnostic {
  return { code, source, path: "", message };
}

function directoryCloseError(source: string): StructuredConfigError {
  return new StructuredConfigError(
    "CONFIG_READ_FAILED",
    source,
    "Waiver directory handle could not be closed",
  );
}

async function listDirectory(
  requestedPath: string,
  resolvedPath: string,
  repository: string,
  source: string,
  entryBudget: DirectoryEntryBudget,
  io: WaiverDiscoveryIo,
): Promise<readonly WaiverCandidate[]> {
  let handle: FileHandle;
  try {
    const flags = constants.O_RDONLY | constants.O_DIRECTORY;
    handle =
      io.openDirectoryHandle === undefined
        ? await open(resolvedPath, flags)
        : await io.openDirectoryHandle(resolvedPath, flags);
  } catch {
    throw new StructuredConfigError(
      "CONFIG_READ_FAILED",
      source,
      "Waiver directory could not be opened",
    );
  }
  let closeAttempted = false;
  try {
    const entries = await readStableDirectoryEntries({
      requestedPath,
      resolvedPath,
      source,
      handle,
      io,
      ...(io.beforeDirectoryEnumeration === undefined
        ? {}
        : {
            beforeEnumeration: async () =>
              io.beforeDirectoryEnumeration?.(requestedPath),
          }),
      inspectEntry: () => {
        entryBudget.inspectedEntries += 1;
        if (entryBudget.inspectedEntries > MAX_WAIVER_DIRECTORY_ENTRIES) {
          throw new StructuredConfigError(
            "WAIVER_DIRECTORY_ENTRY_LIMIT_EXCEEDED",
            source,
            `Waiver directory exceeds ${String(MAX_WAIVER_DIRECTORY_ENTRIES)} inspected entries`,
          );
        }
      },
    });
    const candidates = entries
      .filter(
        (entry) =>
          isWaiverFile(entry.name) &&
          (entry.kind === "file" || entry.kind === "symlink"),
      )
      .map((entry) => {
        const path = join(requestedPath, entry.name);
        return { path, source: sourcePath(repository, path) };
      });
    if (candidates.length > MAX_WAIVERS_PER_MATCH) {
      throw new StructuredConfigError(
        "WAIVER_FILE_LIMIT_EXCEEDED",
        source,
        `Waiver directory exceeds ${String(MAX_WAIVERS_PER_MATCH)} files`,
      );
    }
    const sortedCandidates = candidates.sort((left, right) =>
      compareCodeUnits(left.source, right.source),
    );
    closeAttempted = true;
    try {
      await handle.close();
    } catch {
      throw directoryCloseError(source);
    }
    return sortedCandidates;
  } catch (error) {
    if (!closeAttempted) {
      closeAttempted = true;
      try {
        await handle.close();
      } catch {
        // Preserve the primary enumeration error.
      }
    }
    throw error;
  }
}

async function resolveLocation(
  repository: string,
  resolvedRepository: string,
  location: string,
  io: WaiverDiscoveryIo,
  entryBudget: DirectoryEntryBudget,
): Promise<{
  readonly candidates: readonly WaiverCandidate[];
  readonly diagnostics: readonly PolicyDiagnostic[];
}> {
  const requestedPath = join(repository, location);
  const source = sourcePath(repository, requestedPath);
  if (
    isAbsolute(location) ||
    location === ".." ||
    location.startsWith(`..${sep}`) ||
    location.includes(`${sep}..${sep}`)
  ) {
    return {
      candidates: [],
      diagnostics: [
        locationDiagnostic(
          "CONFIG_PATH_ESCAPE",
          source,
          "Waiver location escapes the repository",
        ),
      ],
    };
  }
  let resolvedPath: string;
  try {
    resolvedPath = await io.realpath(requestedPath);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "UNKNOWN";
    if (code === "ENOENT" && !isWaiverFile(location)) {
      return { candidates: [], diagnostics: [] };
    }
    return {
      candidates: [],
      diagnostics: [
        locationDiagnostic(
          "WAIVER_LOCATION_NOT_FOUND",
          source,
          "Configured waiver location does not exist",
        ),
      ],
    };
  }
  if (!isContained(resolvedRepository, resolvedPath)) {
    return {
      candidates: [],
      diagnostics: [
        locationDiagnostic(
          "CONFIG_PATH_ESCAPE",
          source,
          "Waiver location resolves outside the repository",
        ),
      ],
    };
  }
  let resolvedStats: BigIntStats;
  try {
    resolvedStats = await io.stat(resolvedPath);
  } catch {
    return {
      candidates: [],
      diagnostics: [
        locationDiagnostic(
          "WAIVER_LOCATION_CHANGED",
          source,
          "Waiver location changed after path resolution",
        ),
      ],
    };
  }
  if (resolvedStats.isFile()) {
    return isWaiverFile(location)
      ? { candidates: [{ path: requestedPath, source }], diagnostics: [] }
      : {
          candidates: [],
          diagnostics: [
            locationDiagnostic(
              "WAIVER_LOCATION_UNSUPPORTED",
              source,
              "Waiver files must use .yaml, .yml, or .json",
            ),
          ],
        };
  }
  if (!resolvedStats.isDirectory()) {
    return {
      candidates: [],
      diagnostics: [
        locationDiagnostic(
          "WAIVER_LOCATION_INVALID",
          source,
          "Waiver location must be a file or directory",
        ),
      ],
    };
  }
  try {
    return {
      candidates: await listDirectory(
        requestedPath,
        resolvedPath,
        repository,
        source,
        entryBudget,
        io,
      ),
      diagnostics: [],
    };
  } catch (error) {
    return {
      candidates: [],
      diagnostics:
        error instanceof StructuredConfigError
          ? [configDiagnostic(error)]
          : [
              locationDiagnostic(
                "CONFIG_READ_FAILED",
                source,
                "Waiver directory could not be enumerated",
              ),
            ],
    };
  }
}

export async function discoverWaivers(
  repository: string,
  locations: readonly string[],
  budget: StructuredReadBudget,
  now: Date,
  io: WaiverDiscoveryIo = DEFAULT_DISCOVERY_IO,
  diagnostics = new PolicyDiagnosticCollector(),
): Promise<DiscoveredWaivers> {
  const resolvedRepository = await io.realpath(repository);
  const candidates: WaiverCandidate[] = [];
  const entryBudget: DirectoryEntryBudget = { inspectedEntries: 0 };
  for (const location of locations) {
    if (diagnostics.exhausted) {
      break;
    }
    const resolved = await resolveLocation(
      repository,
      resolvedRepository,
      location,
      io,
      entryBudget,
    );
    diagnostics.add(resolved.diagnostics);
    candidates.push(...resolved.candidates);
    if (candidates.length > MAX_WAIVERS_PER_MATCH) {
      diagnostics.add([
        locationDiagnostic(
          "WAIVER_FILE_LIMIT_EXCEEDED",
          location,
          `Waiver discovery exceeds ${String(MAX_WAIVERS_PER_MATCH)} files`,
        ),
      ]);
      return { waivers: [], diagnostics: diagnostics.toArray(), sources: [] };
    }
  }
  if (diagnostics.hasDiagnostics) {
    return { waivers: [], diagnostics: diagnostics.toArray(), sources: [] };
  }

  const documents: unknown[] = [];
  const documentSources: string[] = [];
  const sources: PolicySource[] = [];
  for (const candidate of candidates.sort((left, right) =>
    compareCodeUnits(left.source, right.source),
  )) {
    if (diagnostics.exhausted) {
      break;
    }
    try {
      const loaded = await loadStructuredFile(candidate.path, {
        containmentRoot: repository,
        source: candidate.source,
        budget,
      });
      documents.push(loaded.data);
      documentSources.push(candidate.source);
      sources.push(filePolicySource("waiver", loaded, 4));
    } catch (error) {
      diagnostics.add([
        error instanceof StructuredConfigError
          ? configDiagnostic(error)
          : locationDiagnostic(
              "CONFIG_READ_FAILED",
              candidate.source,
              "Waiver file could not be loaded",
            ),
      ]);
    }
  }
  if (diagnostics.toArray().length > 0) {
    return { waivers: [], diagnostics: diagnostics.toArray(), sources };
  }
  const validated = validateWaiverInputs(
    documents,
    now,
    documentSources,
    diagnostics,
  );
  const ids = new Set<string>();
  for (const entry of validated.entries) {
    if (diagnostics.exhausted) {
      break;
    }
    if (ids.has(entry.waiver.id)) {
      diagnostics.add([
        locationDiagnostic(
          "DUPLICATE_WAIVER_ID",
          entry.source,
          `Waiver ID ${entry.waiver.id} is duplicated`,
        ),
      ]);
    } else {
      ids.add(entry.waiver.id);
    }
  }
  return {
    waivers: validated.diagnostics.length > 0 ? [] : validated.values,
    diagnostics: diagnostics.toArray(),
    sources,
  };
}
