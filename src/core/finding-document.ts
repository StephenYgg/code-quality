import type { Finding } from "./findings.js";

/**
 * Schema-aligned finding document matching schemas/finding.schema.json.
 * Used for reproducible export; internal Finding may stay slightly looser.
 */
export interface FindingDocument {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly title: string;
  readonly severity: Finding["severity"];
  readonly confidence: "low" | "medium" | "high" | "deterministic";
  readonly status: Finding["lifecycle"];
  readonly disposition: Finding["disposition"];
  readonly locations: readonly {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly startColumn?: number;
    readonly endColumn?: number;
    readonly symbol?: string;
  }[];
  readonly trigger: string;
  readonly actualBehavior: string;
  readonly expectedBehavior: string;
  readonly impact: string;
  readonly evidence: readonly string[];
  readonly remediation: string;
  readonly verification: readonly string[];
  readonly reviewStage: string;
  readonly provider: string;
  readonly model: string;
  readonly timestamps: {
    readonly createdAt: string;
    readonly updatedAt?: string;
    readonly verifiedAt?: string;
  };
}

const RULE_ID = /^CQ-[A-Z]+-[0-9]{3}$/u;

function ensureRuleId(ruleId: string | undefined, stage: string): string {
  if (ruleId !== undefined && RULE_ID.test(ruleId)) return ruleId;
  const map: Record<string, string> = {
    security: "CQ-SEC-001",
    permissions: "CQ-SEC-002",
    concurrency: "CQ-CONC-001",
    readability: "CQ-READ-001",
    testing: "CQ-TEST-001",
    behavior: "CQ-BEH-001",
    universal: "CQ-UNI-001",
  };
  return map[stage] ?? "CQ-REV-001";
}

function ensureExplanation(
  value: string | undefined,
  fallback: string,
): string {
  const text = (value ?? fallback).trim();
  if (text.length >= 5) return text.slice(0, 10_000);
  return fallback.slice(0, 10_000);
}

/**
 * Converts an internal finding into a schema-valid, reproducible document.
 */
export function toFindingDocument(
  finding: Finding,
  defaults?: {
    readonly provider?: string;
    readonly model?: string;
  },
): FindingDocument {
  const stage = finding.stages[0] ?? "universal";
  const path = finding.location?.path ?? "unknown";
  const startLine = finding.location?.startLine ?? 1;
  const endLine = finding.location?.endLine ?? startLine;
  const createdAt = finding.createdAt ?? new Date().toISOString();
  const evidenceText = ensureExplanation(finding.evidence, "See code evidence");
  const verificationText = ensureExplanation(
    finding.verification,
    "Verify against snapshot and context evidence",
  );
  return Object.freeze({
    schemaVersion: "1",
    id: finding.id,
    ruleId: ensureRuleId(finding.ruleId, stage),
    ruleVersion: 1,
    title: finding.title.slice(0, 300),
    severity: finding.severity,
    confidence: finding.confidence,
    status: finding.lifecycle,
    disposition: finding.disposition,
    locations: Object.freeze([
      Object.freeze({
        path,
        startLine,
        endLine,
      }),
    ]),
    trigger: ensureExplanation(finding.trigger, `stage:${stage}`),
    actualBehavior: ensureExplanation(finding.actualBehavior, finding.evidence),
    expectedBehavior: ensureExplanation(
      finding.expectedBehavior,
      "Behavior should satisfy project contracts",
    ),
    impact: ensureExplanation(finding.impact, "Impact requires assessment"),
    evidence: Object.freeze([evidenceText]),
    remediation: ensureExplanation(
      finding.remediation,
      "Remediate with a focused change and tests",
    ),
    verification: Object.freeze([verificationText]),
    reviewStage: stage,
    provider: finding.provider ?? defaults?.provider ?? "unknown",
    model: finding.model ?? defaults?.model ?? "unknown",
    timestamps: Object.freeze({
      createdAt,
      updatedAt: createdAt,
      ...(finding.lifecycle === "confirmed" || finding.lifecycle === "reported"
        ? { verifiedAt: createdAt }
        : {}),
    }),
  });
}
