import type { ReviewRunResult } from "../review/orchestrator.js";
import type { StoredRunRecord } from "../storage/runs.js";

/**
 * Schema-aligned run document matching schemas/run.schema.json.
 * Full finding bodies are exported separately as FindingDocument[].
 * Reproducibility fields enable replay without raw transcripts.
 */
export interface RunDocument {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly input: {
    readonly kind: string;
    readonly scope: string;
    readonly repository: string;
    readonly comparisonBase?: string;
    readonly head: string;
    readonly contentHash: string;
    readonly contentBundleHash: string;
  };
  readonly policyHash: string;
  readonly gate: string;
  readonly findingIds: readonly string[];
  readonly score?: {
    readonly modelId: string;
    readonly modelVersion: string;
    readonly normalizedTenths: number | null;
    readonly coverageTenths: number | null;
  };
  readonly timestamps: {
    readonly startedAt: string;
    readonly completedAt?: string;
  };
  readonly reproducibility: {
    readonly promptBundleVersion: string;
    readonly providerName: string;
    readonly providerKind: string;
    readonly model: string;
    readonly adapterVersion: string;
    readonly providerVersion?: string;
    readonly cacheKey?: string;
    readonly fromCache?: boolean;
    readonly scoreGate: string;
    readonly contextIncomplete: boolean;
    readonly providerAttempts: number;
  };
}

export function toRunDocument(
  result: ReviewRunResult,
  options: {
    readonly policyHash: string;
    readonly providerName: string;
    readonly providerKind: string;
    readonly model: string;
    readonly adapterVersion: string;
    readonly providerVersion?: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
  },
): RunDocument {
  const exportIds = Object.freeze([
    ...result.findings.map((finding) => finding.id),
    ...result.corroborated.map((finding) => finding.id),
    ...result.uncertain.map((finding) => finding.id),
    ...result.waived.map((finding) => finding.id),
  ]);
  const fullScore = result.score;

  const startedAt = options.startedAt ?? new Date().toISOString();
  return Object.freeze({
    schemaVersion: "1",
    id: result.runId,
    input: Object.freeze({
      kind: result.snapshot.inputKind,
      scope: result.snapshot.scope,
      repository: result.snapshot.repository,
      ...(result.snapshot.comparisonBase === undefined
        ? {}
        : { comparisonBase: result.snapshot.comparisonBase }),
      head: result.snapshot.head,
      contentHash: result.snapshot.contentHash,
      contentBundleHash: result.contentBundleHash,
    }),
    policyHash: options.policyHash,
    gate: result.gate,
    findingIds: exportIds,
    ...(fullScore === undefined
      ? {}
      : {
          score: Object.freeze({
            modelId: fullScore.model.id,
            modelVersion: fullScore.model.version,
            normalizedTenths:
              fullScore.totals.normalized === null
                ? null
                : Math.round(fullScore.totals.normalized * 10),
            coverageTenths:
              fullScore.totals.coverage === null
                ? null
                : Math.round(fullScore.totals.coverage * 10),
          }),
        }),
    timestamps: Object.freeze({
      startedAt,
      completedAt: options.completedAt ?? new Date().toISOString(),
    }),
    reproducibility: Object.freeze({
      promptBundleVersion: result.promptBundleVersion,
      providerName: options.providerName,
      providerKind: options.providerKind,
      model: options.model,
      adapterVersion: options.adapterVersion,
      ...(options.providerVersion === undefined
        ? {}
        : { providerVersion: options.providerVersion }),
      ...(result.cacheKey === undefined ? {} : { cacheKey: result.cacheKey }),
      ...(result.fromCache === true ? { fromCache: true } : {}),
      scoreGate: result.scoreGate,
      contextIncomplete: result.contextIncomplete,
      providerAttempts: result.providerAttempts,
    }),
  });
}

/**
 * Prefer the schema-aligned document already stored on the record.
 * Legacy records without runDocument are not supported after schema v1 export.
 */
export function toRunDocumentFromStored(record: StoredRunRecord): RunDocument {
  return record.runDocument;
}
