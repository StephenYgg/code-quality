import type { Finding } from "../core/findings.js";
import { compareCodeUnits } from "../core/deterministic-order.js";
import {
  calculateScore,
  DEFAULT_SCORE_MODEL,
  MAX_ASSESSMENT_EVIDENCE_ITEMS,
  type Assessment,
  type ScoreGate,
  type ScoreModel,
  type ScoreResult,
  type ScoreScope,
} from "../core/scoring.js";
import type { ReviewRunResult } from "./orchestrator.js";

function stageHint(stages: readonly string[]): string {
  return stages.join(",");
}

function ratingFromSeverity(severity: Finding["severity"]): number {
  switch (severity) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2.5;
    case "P3":
      return 3.5;
    case "NIT":
      return 4.5;
  }
}

/**
 * Maps a finding onto the nearest DEFAULT_SCORE_MODEL minor id.
 */
export function minorForFinding(finding: Finding): string {
  const stages = stageHint(finding.stages);
  const title = `${finding.title} ${finding.evidence}`.toLowerCase();
  if (stages.includes("security") || stages.includes("permissions")) {
    if (/secret|token|credential|password|api[_-]?key/.test(title)) {
      return "secrets-privacy-logging-retention-deletion";
    }
    if (
      /injection|ssrf|path traversal|file traversal|open redirect/.test(title)
    ) {
      return "input-injection-path-url-file-safety";
    }
    return "authentication-authorization-tenant-isolation";
  }
  if (stages.includes("concurrency")) {
    if (/lock|contention|mutex/.test(title)) {
      return "lock-scope-ownership-contention";
    }
    if (/queue|retry|backpressure|unbounded/.test(title)) {
      return "bounded-work-retries-queues-backpressure";
    }
    if (/stampede|multi-instance|cache/.test(title)) {
      return "multi-instance-stampede-resource-bounds";
    }
    if (/single-flight|dedup|idempoten/.test(title)) {
      return "single-flight-idempotency-deduplication";
    }
    if (/amplif|hot.?path|capacity|fan.?out/.test(title)) {
      return "hot-path-amplification-capacity";
    }
    return "race-atomicity-toctou";
  }
  if (stages.includes("testing")) {
    if (/fail|error|boundary/.test(title)) {
      return "failure-boundary-coverage";
    }
    return "observable-behavior-coverage";
  }
  if (stages.includes("readability")) {
    if (/try|catch|error boundary/.test(title)) {
      return "try-catch-error-boundaries";
    }
    if (/ternary|fallback|nested/.test(title)) {
      return "conditional-fallback-clarity";
    }
    if (/control flow|stage|state machine/.test(title)) {
      return "control-flow-visible-stages";
    }
    return "function-responsibility-size";
  }
  if (stages.includes("compatibility") || stages.includes("data")) {
    return "api-event-schema-compatibility";
  }
  if (stages.includes("behavior") || stages.includes("universal")) {
    if (/timeout|retry|cancel/.test(title)) {
      return "failure-timeout-retry-cancellation";
    }
    if (/idempoten|side effect|state/.test(title)) {
      return "state-side-effects-idempotency";
    }
    if (/invalid|boundary|input/.test(title)) {
      return "boundaries-invalid-input";
    }
    return "primary-path";
  }
  return "intent-contract";
}

function allMinorIds(model: ScoreModel): readonly string[] {
  return model.majors.flatMap((major) => major.minors.map((item) => item.id));
}

function notAssessed(minorId: string, reason: string): Assessment {
  return {
    minorId,
    status: "not_assessed",
    reason,
    missingEvidence: [`review-stage-assessment:${minorId}`],
  };
}

function capWithFindings(
  assessment: Assessment,
  findings: readonly Finding[],
): Assessment {
  if (findings.length === 0 || assessment.status === "not_assessed") {
    return assessment;
  }
  const cap = Math.min(
    ...findings.map((finding) => ratingFromSeverity(finding.severity)),
  );
  const evidence = findings
    .map(
      (finding) =>
        `${finding.id}:${finding.location?.path ?? "nopath"}:${finding.evidence}`,
    )
    .sort(compareCodeUnits);
  if (assessment.status === "not_applicable") {
    return {
      minorId: assessment.minorId,
      status: "scored",
      rating: cap,
      confidence: findings.some((finding) => finding.confidence === "low")
        ? "low"
        : findings.some((finding) => finding.confidence === "medium")
          ? "medium"
          : "high",
      evidence: boundedEvidence([], evidence),
      explanation:
        "A confirmed finding makes this minor applicable and caps its rating",
    };
  }
  return {
    ...assessment,
    rating: Math.min(assessment.rating, cap),
    evidence: boundedEvidence(assessment.evidence, evidence),
    explanation: `${assessment.explanation}; confirmed findings cap the rating at ${cap.toFixed(1)}`,
  };
}

function boundedEvidence(
  providerEvidence: readonly string[],
  findingEvidence: readonly string[],
): readonly string[] {
  const unique = [...new Set([...providerEvidence, ...findingEvidence])];
  if (unique.length <= MAX_ASSESSMENT_EVIDENCE_ITEMS) {
    return Object.freeze(unique);
  }
  const retained = unique.slice(0, MAX_ASSESSMENT_EVIDENCE_ITEMS - 1);
  const omitted = unique.length - retained.length;
  return Object.freeze([
    ...retained,
    `confirmed-findings: omitted ${String(omitted)} evidence item(s) after deterministic deduplication`,
  ]);
}

/** Materializes an exact, evidence-backed assessment set for the model. */
export function assessmentsFromReview(
  result: Pick<
    ReviewRunResult,
    "findings" | "incomplete" | "providerAttempts" | "assessments"
  >,
  model: ScoreModel = DEFAULT_SCORE_MODEL,
): readonly Assessment[] {
  const expectedIds = allMinorIds(model);
  const expected = new Set(expectedIds);
  const hasExtra = result.assessments.some(
    (assessment) => !expected.has(assessment.minorId),
  );
  const provided = new Map<string, Assessment[]>();
  for (const assessment of result.assessments) {
    const items = provided.get(assessment.minorId) ?? [];
    items.push(assessment);
    provided.set(assessment.minorId, items);
  }
  const byMinor = new Map<string, Finding[]>();
  for (const finding of result.findings) {
    const minor = minorForFinding(finding);
    const list = byMinor.get(minor) ?? [];
    list.push(finding);
    byMinor.set(minor, list);
  }

  const assessments: Assessment[] = [];
  for (const minorId of expectedIds) {
    const findings = byMinor.get(minorId);
    const values = provided.get(minorId) ?? [];
    const assessment = hasExtra
      ? notAssessed(minorId, "Assessment output contained an unknown minor ID")
      : values.length === 0
        ? notAssessed(minorId, "The owning stage omitted this assessment")
        : values.length > 1
          ? notAssessed(minorId, "The owning stage duplicated this assessment")
          : (values[0] ??
            notAssessed(minorId, "The owning stage omitted this assessment"));
    assessments.push(capWithFindings(assessment, findings ?? []));
  }

  return Object.freeze(assessments);
}

export function scoreGateFromReview(
  result: Pick<ReviewRunResult, "incomplete" | "gate">,
): ScoreGate {
  if (result.incomplete) return "INCOMPLETE";
  if (result.gate === "BLOCK") return "BLOCK";
  if (result.gate === "WARN") return "WARN";
  if (result.gate === "INCOMPLETE") return "INCOMPLETE";
  return "PASS";
}

export function scoreScopeFromSnapshot(
  scope: ReviewRunResult["snapshot"]["scope"],
): ScoreScope {
  return scope === "repository" ? "repository" : "change";
}

/**
 * Runs the versioned 100.0 score model against review-derived assessments.
 */
export function scoreFromReview(
  result: Pick<
    ReviewRunResult,
    | "findings"
    | "incomplete"
    | "providerAttempts"
    | "gate"
    | "snapshot"
    | "assessments"
  >,
  model: ScoreModel = DEFAULT_SCORE_MODEL,
): ScoreResult {
  const assessments = assessmentsFromReview(result, model);
  const assessmentById = new Map(
    assessments.map((assessment) => [assessment.minorId, assessment] as const),
  );
  const hasRequiredGap = model.majors.some((major) =>
    major.minors.some(
      (minor) =>
        minor.required &&
        assessmentById.get(minor.id)?.status === "not_assessed",
    ),
  );
  const gate = scoreGateFromReview(result);
  const scored = calculateScore(model, assessments, {
    scope: scoreScopeFromSnapshot(result.snapshot.scope),
    gate,
    blockingFindings: result.findings
      .filter(
        (finding) => finding.severity === "P0" || finding.severity === "P1",
      )
      .map((finding) => ({
        id: finding.id,
        confirmed:
          finding.lifecycle === "confirmed" || finding.lifecycle === "reported",
        blocking: true,
      })),
  });
  return suppressUnavailableFullTotal(
    hasRequiredGap ? { ...scored, gate: "INCOMPLETE" } : scored,
  );
}

function suppressUnavailableFullTotal(result: ScoreResult): ScoreResult {
  const hasRequiredAssessmentGap = result.majors.some((major) =>
    major.minors.some(
      (minor) => minor.required && minor.assessment.status === "not_assessed",
    ),
  );
  const hasAssessmentGap =
    result.scope !== "focused_domain" && hasRequiredAssessmentGap;
  if (!hasAssessmentGap) return result;
  return {
    ...result,
    representsRepositoryTotal: false,
    totals: { ...result.totals, normalized: null },
    display: {
      ...result.display,
      normalized: "N/A",
      maximumLabel:
        "Full total unavailable because required assessments are missing",
    },
  };
}
