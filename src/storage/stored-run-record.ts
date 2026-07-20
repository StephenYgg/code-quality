import type { FindingDocument } from "../core/finding-document.js";
import type { Finding, FindingLifecycle } from "../core/findings.js";
import { createPolicyDocumentValidator } from "../core/policy-schema.js";
import type { RunDocument } from "../core/run-document.js";
import type { Assessment } from "../core/scoring-types.js";
import type { ReviewRunResult } from "../review/orchestrator.js";
import type { ReviewDiagnostic } from "../review/stage-output.js";
import {
  MAX_STORED_DIAGNOSTICS,
  MAX_STORED_DIAGNOSTIC_CODE_BYTES,
  MAX_STORED_DIAGNOSTIC_MESSAGE_BYTES,
  MAX_STORED_DIAGNOSTIC_PATH_BYTES,
  MAX_STORED_DIAGNOSTIC_STAGE_BYTES,
} from "./run-projection.js";

export interface StoredRunRecord {
  readonly schemaVersion: "1";
  readonly runId: string;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly gate: ReviewRunResult["gate"];
  readonly reportHash: string;
  readonly snapshotContentHash: string;
  readonly contentBundleHash: string;
  readonly repository: string;
  readonly comparisonBase?: string;
  readonly head: string;
  readonly inputKind: string;
  readonly scope: string;
  readonly findings: ReviewRunResult["findings"];
  readonly corroborated: ReviewRunResult["corroborated"];
  readonly uncertain: ReviewRunResult["uncertain"];
  readonly waived: ReviewRunResult["waived"];
  readonly diagnostics: readonly ReviewDiagnostic[];
  readonly findingDocuments: readonly FindingDocument[];
  readonly findingIds: readonly string[];
  readonly incomplete: boolean;
  readonly providerAttempts: number;
  readonly promptBundleVersion: string;
  readonly scoreGate: ReviewRunResult["scoreGate"];
  readonly assessments: ReviewRunResult["assessments"];
  readonly contextIncomplete: boolean;
  readonly policyHash: string;
  readonly providerName: string;
  readonly providerKind: string;
  readonly model: string;
  readonly adapterVersion: string;
  readonly providerVersion?: string;
  readonly cacheKey?: string;
  readonly fromCache?: boolean;
  readonly score?: RunDocument["score"];
  readonly timestamps: {
    readonly startedAt: string;
    readonly completedAt: string;
  };
  readonly runDocument: RunDocument;
  readonly sensitiveTranscript?: boolean;
}

export interface StoredRunValidationConstraints {
  readonly cacheKey?: string;
  readonly expectedContentBundleHash?: string;
}

const validateRunDocument = createPolicyDocumentValidator<RunDocument>("run");
const validateFindingDocument =
  createPolicyDocumentValidator<FindingDocument>("finding");
const STORED_RUN_KEYS = Object.freeze([
  "schemaVersion",
  "runId",
  "createdAt",
  "completedAt",
  "gate",
  "reportHash",
  "snapshotContentHash",
  "contentBundleHash",
  "repository",
  "comparisonBase",
  "head",
  "inputKind",
  "scope",
  "findings",
  "corroborated",
  "uncertain",
  "waived",
  "diagnostics",
  "findingDocuments",
  "findingIds",
  "incomplete",
  "providerAttempts",
  "promptBundleVersion",
  "scoreGate",
  "assessments",
  "contextIncomplete",
  "policyHash",
  "providerName",
  "providerKind",
  "model",
  "adapterVersion",
  "providerVersion",
  "cacheKey",
  "fromCache",
  "score",
  "timestamps",
  "runDocument",
  "sensitiveTranscript",
]);

export function isStoredRunRecord(
  value: unknown,
  constraints: StoredRunValidationConstraints = {},
): value is StoredRunRecord {
  try {
    if (!isRecord(value) || !("runDocument" in value)) return false;
    const validation = validateRunDocument(value.runDocument, "stored-run");
    if (
      validation.value === undefined ||
      !hasRequiredRunSections(validation.value)
    ) {
      return false;
    }
    return matchesStoredRun(value, validation.value, constraints);
  } catch {
    return false;
  }
}

function hasRequiredRunSections(document: RunDocument): boolean {
  const value = document as unknown as Record<string, unknown>;
  return isRecord(value.input) && isRecord(value.reproducibility);
}

function matchesStoredRun(
  record: Record<string, unknown>,
  document: RunDocument,
  constraints: StoredRunValidationConstraints,
): record is Record<string, unknown> & StoredRunRecord {
  if (!hasValidMetadata(record, document, constraints)) return false;
  const findings = findingBucket(record.findings, ["confirmed", "reported"]);
  const corroborated = findingBucket(record.corroborated, ["corroborated"]);
  const uncertain = findingBucket(record.uncertain, ["uncertain"]);
  const waived = findingBucket(record.waived, ["waived"]);
  const findingDocuments = validatedFindingDocuments(record.findingDocuments);
  const findingIds = stringArray(record.findingIds);
  if (
    findings === undefined ||
    corroborated === undefined ||
    uncertain === undefined ||
    waived === undefined ||
    findingDocuments === undefined ||
    findingIds === undefined
  ) {
    return false;
  }
  const internalIds = [
    ...findings,
    ...corroborated,
    ...uncertain,
    ...waived,
  ].map((finding) => finding.id);
  return (
    new Set(internalIds).size === internalIds.length &&
    sameStrings(internalIds, document.findingIds) &&
    sameStrings(
      findingDocuments.map((finding) => finding.id),
      document.findingIds,
    ) &&
    sameStrings(findingIds, document.findingIds)
  );
}

function hasValidMetadata(
  record: Record<string, unknown>,
  document: RunDocument,
  constraints: StoredRunValidationConstraints,
): boolean {
  return (
    hasOnlyKeys(record, STORED_RUN_KEYS) &&
    record.schemaVersion === "1" &&
    isNonEmptyString(record.runId) &&
    isTimestamp(record.createdAt) &&
    isTimestamp(record.completedAt) &&
    isHash(record.reportHash) &&
    isHash(record.snapshotContentHash) &&
    isHash(record.contentBundleHash) &&
    isNonEmptyString(record.repository) &&
    optionalString(record.comparisonBase) &&
    isNonEmptyString(record.head) &&
    isNonEmptyString(record.inputKind) &&
    isNonEmptyString(record.scope) &&
    Array.isArray(record.diagnostics) &&
    record.diagnostics.length <= MAX_STORED_DIAGNOSTICS &&
    record.diagnostics.every(isReviewDiagnostic) &&
    Array.isArray(record.assessments) &&
    record.assessments.length <= 1_000 &&
    record.assessments.every(isAssessment) &&
    typeof record.incomplete === "boolean" &&
    typeof record.contextIncomplete === "boolean" &&
    Number.isSafeInteger(record.providerAttempts) &&
    isNonEmptyString(record.promptBundleVersion) &&
    isHash(record.policyHash) &&
    isNonEmptyString(record.providerName) &&
    isNonEmptyString(record.providerKind) &&
    isNonEmptyString(record.model) &&
    isNonEmptyString(record.adapterVersion) &&
    optionalString(record.providerVersion) &&
    optionalHash(record.cacheKey) &&
    optionalBoolean(record.fromCache) &&
    optionalBoolean(record.sensitiveTranscript) &&
    record.runId === document.id &&
    record.gate === document.gate &&
    record.createdAt === document.timestamps.startedAt &&
    record.completedAt === document.timestamps.completedAt &&
    sameScore(record.score, document.score) &&
    sameTimestamps(record.timestamps, document.timestamps) &&
    record.snapshotContentHash === document.input.contentHash &&
    record.contentBundleHash === document.input.contentBundleHash &&
    record.repository === document.input.repository &&
    record.comparisonBase === document.input.comparisonBase &&
    record.head === document.input.head &&
    record.inputKind === document.input.kind &&
    record.scope === document.input.scope &&
    record.policyHash === document.policyHash &&
    record.providerName === document.reproducibility.providerName &&
    record.providerKind === document.reproducibility.providerKind &&
    record.model === document.reproducibility.model &&
    record.adapterVersion === document.reproducibility.adapterVersion &&
    record.providerVersion === document.reproducibility.providerVersion &&
    record.cacheKey === document.reproducibility.cacheKey &&
    record.fromCache === document.reproducibility.fromCache &&
    record.promptBundleVersion ===
      document.reproducibility.promptBundleVersion &&
    record.scoreGate === document.reproducibility.scoreGate &&
    record.contextIncomplete === document.reproducibility.contextIncomplete &&
    record.providerAttempts === document.reproducibility.providerAttempts &&
    (constraints.cacheKey === undefined ||
      record.cacheKey === constraints.cacheKey) &&
    (constraints.expectedContentBundleHash === undefined ||
      record.contentBundleHash === constraints.expectedContentBundleHash)
  );
}

function findingBucket(
  value: unknown,
  lifecycles: readonly FindingLifecycle[],
): readonly Finding[] | undefined {
  return Array.isArray(value) &&
    value.every(
      (finding) => isFinding(finding) && lifecycles.includes(finding.lifecycle),
    )
    ? value
    : undefined;
}

function validatedFindingDocuments(
  value: unknown,
): readonly FindingDocument[] | undefined {
  return Array.isArray(value) &&
    value.every(
      (item, index) =>
        validateFindingDocument(item, `stored-finding-${index.toString()}`)
          .value !== undefined,
    )
    ? value
    : undefined;
}

function isAssessment(value: unknown): value is Assessment {
  if (!isRecord(value) || !isNonEmptyString(value.minorId)) return false;
  if (value.status === "scored") {
    return (
      hasOnlyKeys(value, [
        "minorId",
        "status",
        "rating",
        "confidence",
        "evidence",
        "explanation",
      ]) &&
      typeof value.rating === "number" &&
      Number.isFinite(value.rating) &&
      value.rating >= 0 &&
      value.rating <= 5 &&
      includesString(["low", "medium", "high"], value.confidence) &&
      isNonEmptyStringArray(value.evidence, 128) &&
      isNonEmptyString(value.explanation)
    );
  }
  if (value.status === "not_applicable") {
    return (
      hasOnlyKeys(value, ["minorId", "status", "reason"]) &&
      isNonEmptyString(value.reason)
    );
  }
  if (value.status === "not_assessed") {
    return (
      hasOnlyKeys(value, ["minorId", "status", "reason", "missingEvidence"]) &&
      isNonEmptyString(value.reason) &&
      isNonEmptyStringArray(value.missingEvidence, 128)
    );
  }
  return false;
}

function isFinding(value: unknown): value is Finding {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      "id",
      "ruleId",
      "title",
      "severity",
      "lifecycle",
      "disposition",
      "confidence",
      "stages",
      "location",
      "evidence",
      "impact",
      "remediation",
      "trigger",
      "actualBehavior",
      "expectedBehavior",
      "verification",
      "blockingVerificationUnresolved",
      "provider",
      "model",
      "createdAt",
    ]) &&
    isNonEmptyString(value.id) &&
    optionalString(value.ruleId) &&
    isNonEmptyString(value.title) &&
    includesString(["P0", "P1", "P2", "P3", "NIT"], value.severity) &&
    includesString(
      [
        "candidate",
        "corroborated",
        "confirmed",
        "dismissed",
        "uncertain",
        "waived",
        "reported",
      ],
      value.lifecycle,
    ) &&
    includesString(
      ["new", "preexisting", "unknown", "not_applicable"],
      value.disposition,
    ) &&
    includesString(["low", "medium", "high"], value.confidence) &&
    isStringArray(value.stages, 64) &&
    isFindingLocation(value.location) &&
    isNonEmptyString(value.evidence) &&
    isNonEmptyString(value.impact) &&
    isNonEmptyString(value.remediation) &&
    optionalString(value.trigger) &&
    optionalString(value.actualBehavior) &&
    optionalString(value.expectedBehavior) &&
    optionalString(value.verification) &&
    optionalBoolean(value.blockingVerificationUnresolved) &&
    optionalString(value.provider) &&
    optionalString(value.model) &&
    optionalTimestamp(value.createdAt)
  );
}

function isReviewDiagnostic(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["code", "stageId", "path", "message"])
  ) {
    return false;
  }
  return (
    includesString(
      [
        "PROVIDER_RESPONSE_INVALID",
        "PROVIDER_ATTEMPT_BUDGET_EXHAUSTED",
        "PROVIDER_CONFIG_INVALID",
        "PROVIDER_TIMEOUT",
        "PROVIDER_ABORTED",
        "PROVIDER_RESPONSE_TOO_LARGE",
        "PROVIDER_NETWORK",
        "PROVIDER_CAPACITY",
        "PROVIDER_UNSAFE",
        "PROVIDER_FAILED",
        "RUN_STORAGE_CAPACITY_EXCEEDED",
        "CACHE_CAPACITY_EXCEEDED",
        "SINGLE_FLIGHT_RESULT_UNAVAILABLE",
        "SINGLE_FLIGHT_WAITER_LIMIT",
        "SINGLE_FLIGHT_TIMEOUT",
      ],
      value.code,
    ) &&
    isBoundedString(value.code, MAX_STORED_DIAGNOSTIC_CODE_BYTES, true) &&
    isBoundedString(value.stageId, MAX_STORED_DIAGNOSTIC_STAGE_BYTES, true) &&
    (value.path === undefined ||
      isBoundedString(value.path, MAX_STORED_DIAGNOSTIC_PATH_BYTES, false)) &&
    isBoundedString(value.message, MAX_STORED_DIAGNOSTIC_MESSAGE_BYTES, true)
  );
}

function isFindingLocation(value: unknown): boolean {
  if (value === undefined) return true;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["path", "startLine", "endLine"])
  ) {
    return false;
  }
  return (
    isNonEmptyString(value.path) &&
    optionalPositiveInteger(value.startLine) &&
    optionalPositiveInteger(value.endLine)
  );
}

function sameStrings(left: readonly unknown[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function sameScore(value: unknown, score: RunDocument["score"]): boolean {
  if (score === undefined) return value === undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "modelId",
      "modelVersion",
      "normalizedTenths",
      "coverageTenths",
    ])
  ) {
    return false;
  }
  return (
    value.modelId === score.modelId &&
    value.modelVersion === score.modelVersion &&
    value.normalizedTenths === score.normalizedTenths &&
    value.coverageTenths === score.coverageTenths
  );
}

function sameTimestamps(
  value: unknown,
  timestamps: RunDocument["timestamps"],
): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["startedAt", "completedAt"])) {
    return false;
  }
  return (
    value.startedAt === timestamps.startedAt &&
    value.completedAt === timestamps.completedAt
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function optionalHash(value: unknown): boolean {
  return value === undefined || isHash(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isBoundedString(
  value: unknown,
  maximumBytes: number,
  nonEmpty: boolean,
): value is string {
  return (
    typeof value === "string" &&
    (!nonEmpty || value.length > 0) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function includesString(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function isStringArray(value: unknown, maximum: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((item) => typeof item === "string")
  );
}

function isNonEmptyStringArray(value: unknown, maximum: number): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= maximum &&
    value.every(isNonEmptyString)
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u.test(
      value,
    )
  );
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function optionalPositiveInteger(value: unknown): boolean {
  return (
    value === undefined || (Number.isSafeInteger(value) && Number(value) > 0)
  );
}
