import type { SnapshotExclusion } from "../core/snapshots.js";
import type { RepositoryPathSet } from "./bounded-path-set.js";
import type {
  RepositoryCapture,
  RepositoryFileContent,
  RepositoryManifestLimits,
} from "./repository-manifest-types.js";

export function createRepositoryCapture(
  repository: string,
  head: string,
  pathSet: RepositoryPathSet,
  selected: readonly RepositoryFileContent[],
  exclusions: readonly SnapshotExclusion[],
  exclusionCounts: Readonly<Record<string, number>>,
  incomplete: boolean,
  limits: RepositoryManifestLimits,
  contentHash: string,
): RepositoryCapture {
  return {
    repository,
    head,
    trackedCount: pathSet.trackedCount,
    untrackedCount: pathSet.untrackedCount,
    ignoredCount: pathSet.ignoredCount,
    entryCount: pathSet.entryCount,
    selected: Object.freeze(selected.map((file) => Object.freeze(file))),
    exclusions: Object.freeze(exclusions.map((item) => Object.freeze(item))),
    exclusionCounts,
    incomplete,
    limits,
    contentHash,
  };
}
