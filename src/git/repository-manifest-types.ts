import type { SnapshotExclusion } from "../core/snapshots.js";
import type { ExecutionDescriptor } from "../review/execution-descriptor.js";

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

export type RepositoryManifestContext = ExecutionDescriptor;

export interface RepositoryManifestIo {
  readonly afterEnumeration?: () => Promise<void>;
  readonly beforeSourceVerification?: () => Promise<void>;
}

export interface RepositoryManifestRequest {
  readonly repository: string;
  readonly signal?: AbortSignal;
  readonly io?: RepositoryManifestIo;
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
  readonly ignoredCount: number;
  readonly entryCount: number;
  readonly selected: readonly RepositoryFileContent[];
  readonly exclusions: readonly SnapshotExclusion[];
  readonly exclusionCounts: Readonly<Record<string, number>>;
  readonly incomplete: boolean;
  readonly limits: RepositoryManifestLimits;
  readonly contentHash: string;
}

export interface RepositoryPreflight {
  readonly confirmable: true;
  readonly repository: string;
  readonly head: string;
  readonly trackedCount: number;
  readonly untrackedCount: number;
  readonly ignoredCount: number;
  readonly entryCount: number;
  readonly selectedFileCount: number;
  readonly selectedByteCount: number;
  readonly exclusions: readonly SnapshotExclusion[];
  readonly exclusionCounts: Readonly<Record<string, number>>;
  readonly incomplete: boolean;
  readonly limits: RepositoryManifestLimits;
  readonly providerClass: string;
  readonly endpointClass: string;
  readonly egressClass: string;
  readonly budgets: ExecutionDescriptor["budgets"];
  readonly policyHash: string;
  readonly executionDescriptorVersion: string;
  readonly executionDescriptorHash: string;
  readonly contentHash: string;
  readonly confirmationHash: string;
}

export interface RepositoryDiagnosticPreflight {
  readonly confirmable: false;
  readonly repository: string;
  readonly head: string;
  readonly trackedCount: number;
  readonly untrackedCount: number;
  readonly ignoredCount: number;
  readonly entryCount: number;
  readonly selectedFileCount: number;
  readonly selectedByteCount: number;
  readonly exclusions: readonly SnapshotExclusion[];
  readonly exclusionCounts: Readonly<Record<string, number>>;
  readonly incomplete: boolean;
  readonly limits: RepositoryManifestLimits;
  readonly contentHash: string;
}
