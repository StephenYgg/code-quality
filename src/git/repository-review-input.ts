import { createHash } from "node:crypto";

import {
  createImmutableReviewInput,
  type ImmutableReviewInput,
} from "../core/review-input.js";
import {
  createReviewSnapshot,
  MAX_SNAPSHOT_EXCLUSIONS,
  MAX_SNAPSHOT_FILES,
  type ReviewSnapshot,
  type SnapshotExclusion,
  type SnapshotFile,
} from "../core/snapshots.js";
import {
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_TOTAL_BYTES,
} from "../review/context.js";
import type { RepositoryCapture } from "./repository-manifest.js";

interface RepositoryReviewNormalization {
  readonly exclusions: readonly SnapshotExclusion[];
  readonly content: readonly (readonly [string, Buffer])[];
  readonly incomplete: boolean;
}

function normalizeRepositoryReview(
  capture: RepositoryCapture,
): RepositoryReviewNormalization {
  const visibleExclusions: SnapshotExclusion[] = [];
  const overflowExclusions: SnapshotExclusion[] = [];
  const content: (readonly [string, Buffer])[] = [];
  let totalBytes = 0;
  capture.selected.forEach((file, index) => {
    if (index >= MAX_SNAPSHOT_FILES) {
      overflowExclusions.push({ path: file.path, reason: "file_limit" });
    } else if (index >= MAX_CONTEXT_FILES) {
      visibleExclusions.push({ path: file.path, reason: "file_limit" });
    } else if (file.bytes.length > MAX_CONTEXT_FILE_BYTES) {
      visibleExclusions.push({ path: file.path, reason: "file_limit" });
    } else if (totalBytes + file.bytes.length > MAX_CONTEXT_TOTAL_BYTES) {
      visibleExclusions.push({
        path: file.path,
        reason: "aggregate_byte_limit",
      });
    } else {
      content.push([file.path, file.bytes]);
      totalBytes += file.bytes.length;
    }
  });
  const allExclusions = [
    ...visibleExclusions,
    ...capture.exclusions,
    ...overflowExclusions,
  ];
  return {
    exclusions: allExclusions.slice(0, MAX_SNAPSHOT_EXCLUSIONS),
    content,
    incomplete:
      capture.incomplete ||
      visibleExclusions.length > 0 ||
      overflowExclusions.length > 0 ||
      allExclusions.length > MAX_SNAPSHOT_EXCLUSIONS,
  };
}

function repositorySnapshotFromNormalization(
  capture: RepositoryCapture,
  normalized: RepositoryReviewNormalization,
): ReviewSnapshot {
  const files: SnapshotFile[] = capture.selected
    .slice(0, MAX_SNAPSHOT_FILES)
    .map((file) => ({
      path: file.path,
      status: "modified" as const,
      binary: false,
    }));
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
    exclusions: normalized.exclusions,
    incomplete: normalized.incomplete,
  });
}

export function repositoryCaptureToSnapshot(
  capture: RepositoryCapture,
): ReviewSnapshot {
  return repositorySnapshotFromNormalization(
    capture,
    normalizeRepositoryReview(capture),
  );
}

export function repositoryCaptureToReviewInput(
  capture: RepositoryCapture,
): ImmutableReviewInput {
  const normalized = normalizeRepositoryReview(capture);
  const snapshot = repositorySnapshotFromNormalization(capture, normalized);
  return createImmutableReviewInput(snapshot, normalized.content);
}
