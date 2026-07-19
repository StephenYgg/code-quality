export type ScoreGate = "PASS" | "WARN" | "BLOCK" | "INCOMPLETE";
export type ScoreScope =
  "change" | "affected_surface" | "repository" | "focused_domain";
export type ScoreConfidence = "low" | "medium" | "high";
export type AssessmentStatus = "scored" | "not_applicable" | "not_assessed";
export type MajorAssessmentStatus = AssessmentStatus | "mixed";

export interface RatingAnchors {
  readonly "0.0": string;
  readonly "1.0": string;
  readonly "2.0": string;
  readonly "3.0": string;
  readonly "4.0": string;
  readonly "5.0": string;
}

export interface ScoreMinorModel {
  readonly id: string;
  readonly name: string;
  readonly weightTenths: number;
  readonly required: boolean;
  readonly domainVocabulary: readonly string[];
  readonly ratingAnchors: RatingAnchors;
}

export interface ScoreMajorModel {
  readonly id: string;
  readonly name: string;
  readonly weightTenths: number;
  readonly minors: readonly ScoreMinorModel[];
}

export interface ScoreModel {
  readonly id: string;
  readonly version: string;
  readonly profileHash?: string;
  readonly ruleVersions: Readonly<Record<string, string>>;
  readonly roundingMode: string;
  readonly majors: readonly ScoreMajorModel[];
}

export interface ScoredAssessment {
  readonly minorId: string;
  readonly status: "scored";
  readonly rating: number;
  readonly confidence: ScoreConfidence;
  readonly evidence: readonly string[];
  readonly explanation: string;
}

export interface NotApplicableAssessment {
  readonly minorId: string;
  readonly status: "not_applicable";
  readonly reason: string;
}

export interface NotAssessedAssessment {
  readonly minorId: string;
  readonly status: "not_assessed";
  readonly reason: string;
  readonly missingEvidence: readonly string[];
}

export type Assessment =
  ScoredAssessment | NotApplicableAssessment | NotAssessedAssessment;

export interface BlockingFindingDisposition {
  readonly id: string;
  readonly confirmed: boolean;
  readonly blocking: boolean;
}

export interface ScoreContext {
  readonly scope: ScoreScope;
  readonly focusedDomainId?: string;
  readonly gate: ScoreGate;
  readonly blockingFindings?: readonly BlockingFindingDisposition[];
  readonly baseline?: ScoreResult;
}

export interface ScoreIssue {
  readonly code:
    | "INVALID_DOCUMENT_STRUCTURE"
    | "INVALID_MODEL_ID"
    | "INVALID_MODEL_VERSION"
    | "INVALID_PROFILE_HASH"
    | "INVALID_ROUNDING_MODE"
    | "MODEL_LIMIT_EXCEEDED"
    | "MAJOR_SET_INVALID"
    | "DUPLICATE_MAJOR_ID"
    | "UNNAMED_MAJOR"
    | "INVALID_MAJOR_WEIGHT"
    | "MAJOR_TOTAL_INVALID"
    | "DUPLICATE_MINOR_ID"
    | "UNNAMED_MINOR"
    | "INVALID_MINOR_WEIGHT"
    | "INVALID_DOMAIN_VOCABULARY"
    | "INVALID_RATING_ANCHORS"
    | "MINOR_TOTAL_MISMATCH";
  readonly path: string;
  readonly message: string;
}

export interface ScoreCalculation {
  readonly earnedWeightRatingUnits: number;
  readonly assessedWeightTenths: number;
  readonly applicableWeightTenths: number;
}

export interface ScoreTotals {
  readonly earned: number;
  readonly assessedMaximum: number;
  readonly applicableMaximum: number;
  readonly normalized: number | null;
  readonly coverage: number | null;
}

export interface ScoreDisplay {
  readonly earned: string;
  readonly assessedMaximum: string;
  readonly applicableMaximum: string;
  readonly normalized: string;
  readonly coverage: string;
  readonly raw: string;
  readonly maximumLabel: string;
}

export interface MinorScoreResult {
  readonly id: string;
  readonly name: string;
  readonly weightTenths: number;
  readonly required: boolean;
  readonly assessment: Assessment;
  readonly earned: number | null;
  readonly maximum: number;
  readonly confidence: ScoreConfidence | null;
  readonly calculation: ScoreCalculation;
  readonly display: {
    readonly earned: string;
    readonly maximum: string;
  };
}

export interface MajorScoreResult {
  readonly id: string;
  readonly name: string;
  readonly weightTenths: number;
  readonly minors: readonly MinorScoreResult[];
  readonly totals: ScoreTotals;
  readonly confidence: ScoreConfidence | null;
  readonly calculation: ScoreCalculation;
  readonly display: ScoreDisplay;
}

export interface MinorBaselineChange {
  readonly majorId: string;
  readonly minorId: string;
  readonly baseline: MinorBaselineValue;
  readonly current: MinorBaselineValue;
  readonly comparable: boolean;
  readonly comparisonReason:
    | "numeric_delta"
    | "not_applicable_unchanged_non_numeric"
    | "not_assessed_unchanged_non_numeric"
    | "assessment_status_changed";
  readonly earnedDelta: number | null;
  readonly display: { readonly earnedDelta: string };
}

export interface MinorBaselineValue {
  readonly status: AssessmentStatus;
  readonly rating: number | null;
  readonly earned: number | null;
  readonly maximum: number;
  readonly display: {
    readonly earned: string;
    readonly maximum: string;
  };
}

export interface MajorBaselineChange {
  readonly majorId: string;
  readonly baseline: MajorBaselineValue;
  readonly current: MajorBaselineValue;
  readonly comparable: boolean;
  readonly normalizedDelta: number | null;
  readonly display: { readonly normalizedDelta: string };
}

export interface MajorBaselineValue {
  readonly status: MajorAssessmentStatus;
  readonly earned: number;
  readonly assessedMaximum: number;
  readonly applicableMaximum: number;
  readonly normalized: number | null;
  readonly coverage: number | null;
  readonly display: ScoreDisplay;
}

export interface BaselineComparison {
  readonly comparable: boolean;
  readonly reason: string | null;
  readonly normalizedDelta: number | null;
  readonly majorChanges: readonly MajorBaselineChange[];
  readonly minorChanges: readonly MinorBaselineChange[];
  readonly display: { readonly normalizedDelta: string };
}

export interface ScoreResult {
  readonly model: {
    readonly id: string;
    readonly version: string;
    readonly profileHash: string | null;
    readonly ruleVersions: Readonly<Record<string, string>>;
    readonly roundingMode: "half_up";
    readonly compatibilitySignature: string;
  };
  readonly scope: ScoreScope;
  readonly focusedDomainId?: string;
  readonly representsRepositoryTotal: boolean;
  readonly gate: ScoreGate;
  readonly confidence: ScoreConfidence | null;
  readonly confidenceAggregation: "minimum_assessed";
  readonly majors: readonly MajorScoreResult[];
  readonly totals: ScoreTotals;
  readonly calculation: ScoreCalculation;
  readonly display: ScoreDisplay;
  readonly baseline?: BaselineComparison;
}
