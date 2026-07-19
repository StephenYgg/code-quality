import type {
  Assessment,
  ScoreConfidence,
  ScoreMajorModel,
} from "./scoring-types.js";
import {
  MAX_ASSESSMENT_EVIDENCE_ITEMS,
  MAX_ASSESSMENT_TEXT_BYTES_PER_SCORE,
  MAX_ASSESSMENT_TEXT_CODE_POINTS,
} from "./scoring-assessment-limits.js";

const SCORED_KEYS = [
  "confidence",
  "evidence",
  "explanation",
  "minorId",
  "rating",
  "status",
] as const;
const NOT_APPLICABLE_KEYS = ["minorId", "reason", "status"] as const;
const NOT_ASSESSED_KEYS = [
  "minorId",
  "missingEvidence",
  "reason",
  "status",
] as const;

export function validateAndSnapshotAssessments(
  majors: readonly ScoreMajorModel[],
  input: unknown,
): ReadonlyMap<string, Assessment> {
  if (!Array.isArray(input)) {
    throw new TypeError("Assessments must be an array");
  }
  const expectedIds = new Set(
    majors.flatMap((major) => major.minors.map((item) => item.id)),
  );
  if (input.length > expectedIds.size) {
    throw new TypeError("Assessment array contains duplicate or unknown items");
  }
  const validatedById = new Map<string, Assessment>();
  const textBudget = { usedBytes: 0 };
  for (const value of input as readonly unknown[]) {
    const assessment = validateAssessment(value, textBudget);
    if (!expectedIds.has(assessment.minorId)) {
      throw new TypeError(
        `Assessment has unknown minorId: ${assessment.minorId}`,
      );
    }
    if (validatedById.has(assessment.minorId)) {
      throw new TypeError(
        `Assessment has duplicate minorId: ${assessment.minorId}`,
      );
    }
    validatedById.set(assessment.minorId, assessment);
  }
  const missing = [...expectedIds].filter((id) => !validatedById.has(id));
  if (missing.length > 0) {
    throw new TypeError(`Assessments are missing: ${missing.join(", ")}`);
  }
  return new Map(
    [...validatedById].map(([minorId, assessment]) => [
      minorId,
      snapshotAssessment(assessment),
    ]),
  );
}

interface TextBudget {
  usedBytes: number;
}

function validateAssessment(value: unknown, budget: TextBudget): Assessment {
  if (!isRecord(value)) {
    throw new TypeError("Assessment must be a non-null object");
  }
  const minorId = requiredString(value.minorId, "minorId");
  const status = value.status;
  switch (status) {
    case "scored":
      return validateScored(value, minorId, budget);
    case "not_applicable":
      return validateNotApplicable(value, minorId, budget);
    case "not_assessed":
      return validateNotAssessed(value, minorId, budget);
    default:
      throw new TypeError(`Assessment ${minorId} has an invalid status`);
  }
}

function validateScored(
  value: Readonly<Record<string, unknown>>,
  minorId: string,
  budget: TextBudget,
): Assessment {
  requireExactKeys(value, SCORED_KEYS, minorId);
  const rating = value.rating;
  if (
    typeof rating !== "number" ||
    !Number.isInteger(rating * 2) ||
    rating < 0 ||
    rating > 5
  ) {
    throw new TypeError(
      `Assessment ${minorId} rating must be 0..5 in 0.5 increments`,
    );
  }
  const confidence = value.confidence;
  if (!isScoreConfidence(confidence)) {
    throw new TypeError(`Assessment ${minorId} confidence is invalid`);
  }
  const evidence = requiredTextArray(
    value.evidence,
    "evidence",
    minorId,
    budget,
  );
  const explanation = requiredText(
    value.explanation,
    "explanation",
    minorId,
    budget,
  );
  return {
    minorId,
    status: "scored",
    rating,
    confidence,
    evidence,
    explanation,
  };
}

function validateNotApplicable(
  value: Readonly<Record<string, unknown>>,
  minorId: string,
  budget: TextBudget,
): Assessment {
  requireExactKeys(value, NOT_APPLICABLE_KEYS, minorId);
  return {
    minorId,
    status: "not_applicable",
    reason: requiredText(
      value.reason,
      "reason",
      minorId,
      budget,
      "not_applicable reason",
    ),
  };
}

function validateNotAssessed(
  value: Readonly<Record<string, unknown>>,
  minorId: string,
  budget: TextBudget,
): Assessment {
  requireExactKeys(value, NOT_ASSESSED_KEYS, minorId);
  return {
    minorId,
    status: "not_assessed",
    reason: requiredText(
      value.reason,
      "reason",
      minorId,
      budget,
      "not_assessed reason",
    ),
    missingEvidence: requiredTextArray(
      value.missingEvidence,
      "missingEvidence",
      minorId,
      budget,
      "not_assessed missing evidence",
    ),
  };
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  minorId: string,
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw new TypeError(`Assessment ${minorId} has missing or unknown fields`);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Assessment ${field} must be a non-empty string`);
  }
  return value;
}

function requiredText(
  value: unknown,
  field: string,
  minorId: string,
  budget: TextBudget,
  invalidField = field,
): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `Assessment ${minorId} ${invalidField} must be a non-empty string`,
    );
  }
  assertCodePointLimit(value, field, minorId);
  if (value.trim().length === 0) {
    throw new TypeError(
      `Assessment ${minorId} ${invalidField} must be a non-empty string`,
    );
  }
  consumeTextBudget(value, budget);
  return value;
}

function requiredTextArray(
  value: unknown,
  field: string,
  minorId: string,
  budget: TextBudget,
  invalidField = field,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(
      `Assessment ${minorId} ${invalidField} must contain non-empty strings`,
    );
  }
  if (value.length > MAX_ASSESSMENT_EVIDENCE_ITEMS) {
    throw new TypeError(
      `Assessment ${minorId} ${field} exceeds maximum ${MAX_ASSESSMENT_EVIDENCE_ITEMS.toString()} entries`,
    );
  }
  const entries: readonly unknown[] = value;
  for (const entry of entries) {
    requiredText(entry, field, minorId, budget, invalidField);
  }
  return entries as readonly string[];
}

function assertCodePointLimit(
  value: string,
  field: string,
  minorId: string,
): void {
  let codePoints = 0;
  let codeUnitIndex = 0;
  while (codeUnitIndex < value.length) {
    const codePoint = value.codePointAt(codeUnitIndex);
    if (codePoint === undefined) break;
    codeUnitIndex += codePoint > 0xffff ? 2 : 1;
    codePoints += 1;
    if (codePoints > MAX_ASSESSMENT_TEXT_CODE_POINTS) {
      throw new TypeError(
        `Assessment ${minorId} ${field} exceeds maximum ${MAX_ASSESSMENT_TEXT_CODE_POINTS.toString()} Unicode code points`,
      );
    }
  }
}

function consumeTextBudget(value: string, budget: TextBudget): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_ASSESSMENT_TEXT_BYTES_PER_SCORE - budget.usedBytes) {
    throw new TypeError(
      `Assessment text exceeds aggregate UTF-8 budget of ${MAX_ASSESSMENT_TEXT_BYTES_PER_SCORE.toString()} bytes`,
    );
  }
  budget.usedBytes += bytes;
}

function snapshotAssessment(assessment: Assessment): Assessment {
  switch (assessment.status) {
    case "scored":
      return Object.freeze({
        ...assessment,
        evidence: Object.freeze([...assessment.evidence]),
      });
    case "not_assessed":
      return Object.freeze({
        ...assessment,
        missingEvidence: Object.freeze([...assessment.missingEvidence]),
      });
    case "not_applicable":
      return Object.freeze({ ...assessment });
  }
}

function isScoreConfidence(value: unknown): value is ScoreConfidence {
  return value === "low" || value === "medium" || value === "high";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
