import {
  createModelCompatibilitySignature,
  validateScoreModel,
} from "./scoring-model.js";
import { validateAndSnapshotAssessments } from "./scoring-assessments.js";
import type {
  Assessment,
  BaselineComparison,
  MajorAssessmentStatus,
  MajorBaselineChange,
  MajorBaselineValue,
  MajorScoreResult,
  MinorBaselineChange,
  MinorBaselineValue,
  MinorScoreResult,
  ScoreCalculation,
  ScoreConfidence,
  ScoreContext,
  ScoreDisplay,
  ScoreGate,
  ScoreMajorModel,
  ScoreMinorModel,
  ScoreModel,
  ScoreResult,
  ScoreTotals,
} from "./scoring-types.js";

export function calculateScore(
  model: ScoreModel,
  assessments: unknown,
  context: ScoreContext,
): ScoreResult {
  const modelIssues = validateScoreModel(model);
  if (modelIssues.length > 0) {
    const details = modelIssues
      .map((item) => `${item.path}: ${item.message}`)
      .join("; ");
    throw new TypeError(`Invalid score model: ${details}`);
  }
  const selectedMajors = selectMajors(model, context);
  const assessmentMap = validateAndSnapshotAssessments(
    selectedMajors,
    assessments,
  );
  const majors = selectedMajors.map((major) =>
    scoreMajor(major, assessmentMap),
  );
  const calculation = aggregateCalculations(
    majors.map((major) => major.calculation),
  );
  const result: ScoreResult = {
    model: {
      id: model.id,
      version: model.version,
      profileHash: model.profileHash ?? null,
      ruleVersions: { ...model.ruleVersions },
      roundingMode: "half_up",
      compatibilitySignature: createModelCompatibilitySignature(model),
    },
    scope: context.scope,
    ...(context.focusedDomainId === undefined
      ? {}
      : { focusedDomainId: context.focusedDomainId }),
    representsRepositoryTotal: context.scope === "repository",
    gate: resolveGate(context, selectedMajors, assessmentMap),
    confidence: aggregateConfidence(majors.map((major) => major.confidence)),
    confidenceAggregation: "minimum_assessed",
    majors,
    totals: totalsFrom(calculation),
    calculation,
    display: displayFrom(
      calculation,
      context.scope === "focused_domain"
        ? `${formatTenths(calculation.applicableWeightTenths)} focused-domain points`
        : "100.0 total points",
    ),
  };
  return context.baseline === undefined
    ? result
    : { ...result, baseline: compareBaseline(result, context.baseline) };
}

function selectMajors(
  model: ScoreModel,
  context: ScoreContext,
): readonly ScoreMajorModel[] {
  if (context.scope !== "focused_domain") {
    if (context.focusedDomainId !== undefined) {
      throw new TypeError(
        "focusedDomainId is only valid for focused_domain scope",
      );
    }
    return model.majors;
  }
  if (
    context.focusedDomainId === undefined ||
    context.focusedDomainId.trim().length === 0
  ) {
    throw new TypeError("focused_domain scope requires focusedDomainId");
  }
  const major = model.majors.find(
    (item) => item.id === context.focusedDomainId,
  );
  if (major === undefined) {
    throw new TypeError(`Unknown focused domain: ${context.focusedDomainId}`);
  }
  return [major];
}

function scoreMajor(
  major: ScoreMajorModel,
  assessments: ReadonlyMap<string, Assessment>,
): MajorScoreResult {
  const minors = major.minors.map((item) => {
    const assessment = assessments.get(item.id);
    if (assessment === undefined) {
      throw new TypeError(`Missing assessment: ${item.id}`);
    }
    return scoreMinor(item, assessment);
  });
  const calculation = aggregateCalculations(
    minors.map((item) => item.calculation),
  );
  return {
    id: major.id,
    name: major.name,
    weightTenths: major.weightTenths,
    minors,
    totals: totalsFrom(calculation),
    confidence: aggregateConfidence(minors.map((item) => item.confidence)),
    calculation,
    display: displayFrom(
      calculation,
      `${formatTenths(calculation.applicableWeightTenths)} major points`,
    ),
  };
}

function scoreMinor(
  model: ScoreMinorModel,
  assessment: Assessment,
): MinorScoreResult {
  const assessed = assessment.status === "scored";
  const applicable = assessment.status !== "not_applicable";
  const earnedUnits = assessed
    ? model.weightTenths * assessment.rating * 10
    : 0;
  const calculation: ScoreCalculation = {
    earnedWeightRatingUnits: earnedUnits,
    assessedWeightTenths: assessed ? model.weightTenths : 0,
    applicableWeightTenths: applicable ? model.weightTenths : 0,
  };
  return {
    id: model.id,
    name: model.name,
    weightTenths: model.weightTenths,
    required: model.required,
    assessment,
    earned: assessed ? earnedUnits / 500 : null,
    maximum: model.weightTenths / 10,
    confidence: assessed ? assessment.confidence : null,
    calculation,
    display: {
      earned: assessed ? formatFraction(earnedUnits, 500) : "N/A",
      maximum: formatTenths(model.weightTenths),
    },
  };
}

function aggregateCalculations(
  calculations: readonly ScoreCalculation[],
): ScoreCalculation {
  return calculations.reduce<ScoreCalculation>(
    (total, item) => ({
      earnedWeightRatingUnits:
        total.earnedWeightRatingUnits + item.earnedWeightRatingUnits,
      assessedWeightTenths:
        total.assessedWeightTenths + item.assessedWeightTenths,
      applicableWeightTenths:
        total.applicableWeightTenths + item.applicableWeightTenths,
    }),
    {
      earnedWeightRatingUnits: 0,
      assessedWeightTenths: 0,
      applicableWeightTenths: 0,
    },
  );
}

function totalsFrom(calculation: ScoreCalculation): ScoreTotals {
  return {
    earned: calculation.earnedWeightRatingUnits / 500,
    assessedMaximum: calculation.assessedWeightTenths / 10,
    applicableMaximum: calculation.applicableWeightTenths / 10,
    normalized:
      calculation.assessedWeightTenths === 0
        ? null
        : (calculation.earnedWeightRatingUnits * 2) /
          calculation.assessedWeightTenths,
    coverage:
      calculation.applicableWeightTenths === 0
        ? null
        : (calculation.assessedWeightTenths * 100) /
          calculation.applicableWeightTenths,
  };
}

function displayFrom(
  calculation: ScoreCalculation,
  maximumLabel: string,
): ScoreDisplay {
  const earned = formatFraction(calculation.earnedWeightRatingUnits, 500);
  const assessedMaximum = formatTenths(calculation.assessedWeightTenths);
  const applicableMaximum = formatTenths(calculation.applicableWeightTenths);
  return {
    earned,
    assessedMaximum,
    applicableMaximum,
    normalized:
      calculation.assessedWeightTenths === 0
        ? "N/A"
        : formatFraction(
            calculation.earnedWeightRatingUnits * 2,
            calculation.assessedWeightTenths,
          ),
    coverage:
      calculation.applicableWeightTenths === 0
        ? "N/A"
        : formatFraction(
            calculation.assessedWeightTenths * 100,
            calculation.applicableWeightTenths,
          ),
    raw: `${earned}/${assessedMaximum} assessed applicable points`,
    maximumLabel,
  };
}

function resolveGate(
  context: ScoreContext,
  majors: readonly ScoreMajorModel[],
  assessments: ReadonlyMap<string, Assessment>,
): ScoreGate {
  const confirmedBlock = context.blockingFindings?.some(
    (item) => item.confirmed && item.blocking,
  );
  if (context.gate === "BLOCK" || confirmedBlock === true) return "BLOCK";
  const requiredGap = majors.some((major) =>
    major.minors.some(
      (model) =>
        model.required && assessments.get(model.id)?.status === "not_assessed",
    ),
  );
  if (context.gate === "INCOMPLETE" || requiredGap) return "INCOMPLETE";
  return context.gate;
}

function aggregateConfidence(
  confidenceValues: readonly (ScoreConfidence | null)[],
): ScoreConfidence | null {
  const values = confidenceValues.filter(
    (value): value is ScoreConfidence => value !== null,
  );
  if (values.length === 0) return null;
  if (values.includes("low")) return "low";
  if (values.includes("medium")) return "medium";
  return "high";
}

function compareBaseline(
  current: ScoreResult,
  baseline: ScoreResult,
): BaselineComparison {
  const reason = baselineIncompatibility(current, baseline);
  if (reason !== null) {
    return {
      comparable: false,
      reason,
      normalizedDelta: null,
      majorChanges: [],
      minorChanges: [],
      display: { normalizedDelta: "N/A" },
    };
  }
  const minorChanges = compareMinors(current, baseline);
  const statesComparable = minorChanges.every(
    (change) => change.baseline.status === change.current.status,
  );
  const delta = statesComparable
    ? normalizedDelta(current.calculation, baseline.calculation)
    : { value: null, display: "state changed" };
  return {
    comparable: true,
    reason: null,
    normalizedDelta: delta.value,
    majorChanges: compareMajors(current, baseline),
    minorChanges,
    display: { normalizedDelta: delta.display },
  };
}

function baselineIncompatibility(
  current: ScoreResult,
  baseline: ScoreResult,
): string | null {
  if (
    current.scope !== baseline.scope ||
    current.focusedDomainId !== baseline.focusedDomainId
  ) {
    return "Baseline scope is not equivalent";
  }
  if (
    current.model.id !== baseline.model.id ||
    current.model.version !== baseline.model.version
  ) {
    return "Baseline score-model ID or version is not equivalent";
  }
  return current.model.compatibilitySignature ===
    baseline.model.compatibilitySignature
    ? null
    : "Baseline score-model weights or semantic definition are not equivalent";
}

function compareMinors(
  current: ScoreResult,
  baseline: ScoreResult,
): readonly MinorBaselineChange[] {
  const previousById = new Map(
    baseline.majors.flatMap((major) =>
      major.minors.map((item) => [item.id, item] as const),
    ),
  );
  return current.majors.flatMap((major) =>
    major.minors.map((item) => {
      const previous = previousById.get(item.id);
      if (previous === undefined) {
        throw new TypeError(`Equivalent baseline is missing minor: ${item.id}`);
      }
      const comparable =
        item.assessment.status === "scored" &&
        previous.assessment.status === "scored";
      const comparisonReason = minorComparisonReason(item, previous);
      const numerator =
        item.calculation.earnedWeightRatingUnits -
        previous.calculation.earnedWeightRatingUnits;
      return {
        majorId: major.id,
        minorId: item.id,
        baseline: minorBaselineValue(previous),
        current: minorBaselineValue(item),
        comparable,
        comparisonReason,
        earnedDelta: comparable ? numerator / 500 : null,
        display: {
          earnedDelta: minorDeltaDisplay(comparisonReason, numerator),
        },
      };
    }),
  );
}

function minorDeltaDisplay(
  reason: MinorBaselineChange["comparisonReason"],
  earnedUnitsDelta: number,
): string {
  switch (reason) {
    case "numeric_delta":
      return formatSignedFraction(earnedUnitsDelta, 500);
    case "not_applicable_unchanged_non_numeric":
      return "not applicable unchanged";
    case "not_assessed_unchanged_non_numeric":
      return "not assessed unchanged";
    case "assessment_status_changed":
      return "state changed";
  }
}

function minorComparisonReason(
  current: MinorScoreResult,
  baseline: MinorScoreResult,
): MinorBaselineChange["comparisonReason"] {
  const currentStatus = current.assessment.status;
  const baselineStatus = baseline.assessment.status;
  if (currentStatus !== baselineStatus) return "assessment_status_changed";
  if (currentStatus === "not_applicable") {
    return "not_applicable_unchanged_non_numeric";
  }
  if (currentStatus === "not_assessed") {
    return "not_assessed_unchanged_non_numeric";
  }
  return "numeric_delta";
}

function compareMajors(
  current: ScoreResult,
  baseline: ScoreResult,
): readonly MajorBaselineChange[] {
  const previousById = new Map(
    baseline.majors.map((major) => [major.id, major] as const),
  );
  return current.majors.map((major) => {
    const previous = previousById.get(major.id);
    if (previous === undefined) {
      throw new TypeError(`Equivalent baseline is missing major: ${major.id}`);
    }
    const statusesComparable = haveSameMinorStatuses(major, previous);
    const delta = statusesComparable
      ? normalizedDelta(major.calculation, previous.calculation)
      : { value: null, display: "state changed" };
    return {
      majorId: major.id,
      baseline: majorBaselineValue(previous),
      current: majorBaselineValue(major),
      comparable: statusesComparable && delta.value !== null,
      normalizedDelta: delta.value,
      display: { normalizedDelta: delta.display },
    };
  });
}

function minorBaselineValue(item: MinorScoreResult): MinorBaselineValue {
  return {
    status: item.assessment.status,
    rating: item.assessment.status === "scored" ? item.assessment.rating : null,
    earned: item.earned,
    maximum: item.maximum,
    display: item.display,
  };
}

function majorBaselineValue(item: MajorScoreResult): MajorBaselineValue {
  return {
    status: aggregateMajorStatus(item),
    earned: item.totals.earned,
    assessedMaximum: item.totals.assessedMaximum,
    applicableMaximum: item.totals.applicableMaximum,
    normalized: item.totals.normalized,
    coverage: item.totals.coverage,
    display: item.display,
  };
}

function aggregateMajorStatus(item: MajorScoreResult): MajorAssessmentStatus {
  const firstStatus = item.minors[0]?.assessment.status;
  if (firstStatus === undefined) return "not_assessed";
  return item.minors.every(
    (minorResult) => minorResult.assessment.status === firstStatus,
  )
    ? firstStatus
    : "mixed";
}

function haveSameMinorStatuses(
  current: MajorScoreResult,
  baseline: MajorScoreResult,
): boolean {
  const baselineStatuses = new Map(
    baseline.minors.map((item) => [item.id, item.assessment.status] as const),
  );
  return current.minors.every(
    (item) => baselineStatuses.get(item.id) === item.assessment.status,
  );
}

function normalizedDelta(
  current: ScoreCalculation,
  baseline: ScoreCalculation,
): { readonly value: number | null; readonly display: string } {
  if (
    current.assessedWeightTenths === 0 ||
    baseline.assessedWeightTenths === 0
  ) {
    return { value: null, display: "N/A" };
  }
  const numerator =
    current.earnedWeightRatingUnits * 2 * baseline.assessedWeightTenths -
    baseline.earnedWeightRatingUnits * 2 * current.assessedWeightTenths;
  const denominator =
    current.assessedWeightTenths * baseline.assessedWeightTenths;
  return {
    value: numerator / denominator,
    display: formatSignedFraction(numerator, denominator),
  };
}

function formatTenths(tenths: number): string {
  return (tenths / 10).toFixed(1);
}

function formatFraction(numerator: number, denominator: number): string {
  if (denominator <= 0) return "N/A";
  return (divideRoundHalfUp(numerator * 10, denominator) / 10).toFixed(1);
}

function formatSignedFraction(numerator: number, denominator: number): string {
  if (denominator <= 0) return "N/A";
  const value = divideRoundHalfUp(Math.abs(numerator) * 10, denominator) / 10;
  if (value === 0) return "0.0";
  return `${numerator > 0 ? "+" : "-"}${value.toFixed(1)}`;
}

function divideRoundHalfUp(numerator: number, denominator: number): number {
  return Math.floor(numerator / denominator + 0.5);
}
