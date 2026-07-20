import { createHash } from "node:crypto";

import { executionDescriptorHash } from "../review/execution-descriptor.js";
import type {
  RepositoryCapture,
  RepositoryDiagnosticPreflight,
  RepositoryManifestContext,
  RepositoryPreflight,
} from "./repository-manifest-types.js";

function selectedByteCount(capture: RepositoryCapture): number {
  return capture.selected.reduce((total, file) => total + file.size, 0);
}

export function repositoryConfirmationHash(
  contentHash: string,
  context: RepositoryManifestContext,
): string {
  return createHash("sha256")
    .update("cq-repository-confirm:v2\0")
    .update(contentHash)
    .update("\0")
    .update(executionDescriptorHash(context))
    .digest("hex");
}

export function createRepositoryDiagnosticPreflight(
  capture: RepositoryCapture,
): RepositoryDiagnosticPreflight {
  return Object.freeze({
    confirmable: false,
    repository: capture.repository,
    head: capture.head,
    trackedCount: capture.trackedCount,
    untrackedCount: capture.untrackedCount,
    ignoredCount: capture.ignoredCount,
    entryCount: capture.entryCount,
    selectedFileCount: capture.selected.length,
    selectedByteCount: selectedByteCount(capture),
    exclusions: capture.exclusions,
    exclusionCounts: capture.exclusionCounts,
    incomplete: capture.incomplete,
    limits: capture.limits,
    contentHash: capture.contentHash,
  });
}

export function createRepositoryPreflight(
  capture: RepositoryCapture,
  context: RepositoryManifestContext,
): RepositoryPreflight {
  return Object.freeze({
    confirmable: true,
    repository: capture.repository,
    head: capture.head,
    trackedCount: capture.trackedCount,
    untrackedCount: capture.untrackedCount,
    ignoredCount: capture.ignoredCount,
    entryCount: capture.entryCount,
    selectedFileCount: capture.selected.length,
    selectedByteCount: selectedByteCount(capture),
    exclusions: capture.exclusions,
    exclusionCounts: capture.exclusionCounts,
    incomplete: capture.incomplete,
    limits: capture.limits,
    providerClass: context.provider.providerClass,
    endpointClass: context.endpoint.class,
    egressClass: context.egress.class,
    budgets: context.budgets,
    policyHash: context.policy.hash,
    executionDescriptorVersion: context.schemaVersion,
    executionDescriptorHash: executionDescriptorHash(context),
    contentHash: capture.contentHash,
    confirmationHash: repositoryConfirmationHash(capture.contentHash, context),
  });
}
