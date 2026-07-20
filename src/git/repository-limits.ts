import {
  RepositoryManifestError,
  type RepositoryManifestLimits,
} from "./repository-manifest-types.js";

export const DEFAULT_REPOSITORY_FILE_LIMIT = 5_000;
export const DEFAULT_REPOSITORY_BYTE_LIMIT = 50 * 1024 * 1024;
export const DEFAULT_REPOSITORY_ENTRY_LIMIT = 20_000;
export const DEFAULT_REPOSITORY_INDIVIDUAL_FILE_BYTES = 1 * 1024 * 1024;
export const MAX_REPOSITORY_FILE_LIMIT = 5_000;
export const MAX_REPOSITORY_BYTE_LIMIT = 50 * 1024 * 1024;

export function resolveRepositoryManifestLimits(
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
