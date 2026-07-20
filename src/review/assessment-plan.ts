import type { ReviewStageId } from "../core/risk-router.js";
import type {
  Assessment,
  NotAssessedAssessment,
  ScoreMajorModel,
  ScoreMinorModel,
  ScoreModel,
} from "../core/scoring-types.js";
import type { ReviewSnapshot } from "../core/snapshots.js";
import type { ReviewContextBundle } from "./context.js";
import { createImmutableSourceQuoteVerifier } from "./evidence-verifier.js";
import type { StageAssessment } from "./stage-output.js";

export interface ReviewAssessmentPlan {
  readonly assignments: readonly {
    readonly stageId: ReviewStageId;
    readonly minors: readonly ScoreMinorModel[];
  }[];
  readonly owners: ReadonlyMap<string, ReviewStageId>;
  readonly unrouted: readonly {
    readonly majorId: string;
    readonly minorId: string;
    readonly requiredStages: readonly ReviewStageId[];
  }[];
}

interface MajorRoute {
  readonly stages: readonly ReviewStageId[];
  readonly requiresSpecialist?: boolean;
}

const MAJOR_ROUTES: Readonly<Record<string, MajorRoute>> = Object.freeze({
  correctness: { stages: ["behavior", "universal"] },
  readability: { stages: ["readability", "universal"] },
  architecture: { stages: ["universal", "readability"] },
  testing: { stages: ["testing", "universal"] },
  concurrency: {
    stages: [
      "concurrency",
      "cache",
      "jobs",
      "events",
      "performance",
      "universal",
    ],
  },
  security: {
    stages: ["security", "permissions"],
    requiresSpecialist: true,
  },
  compatibility: {
    stages: ["compatibility", "data", "external_api", "universal"],
  },
  "observability-docs-supply-chain": {
    stages: ["universal", "testing"],
  },
});

function ownerForMajor(
  major: ScoreMajorModel,
  actualStages: readonly ReviewStageId[],
): ReviewStageId | undefined {
  const available = new Set(actualStages);
  const route = MAJOR_ROUTES[major.id] ?? { stages: ["universal"] };
  const preferred = route.stages.find((stage) => available.has(stage));
  if (preferred !== undefined || route.requiresSpecialist === true) {
    return preferred;
  }
  const fallback = actualStages[0];
  if (fallback === undefined) {
    throw new TypeError("Assessment ownership requires an actual stage");
  }
  return fallback;
}

export function createAssessmentPlan(
  stages: readonly ReviewStageId[],
  model: ScoreModel,
): ReviewAssessmentPlan {
  if (stages.length === 0) {
    throw new TypeError(
      "Assessment ownership requires at least one review stage",
    );
  }
  const byStage = new Map<ReviewStageId, ScoreMinorModel[]>(
    stages.map((stage) => [stage, []]),
  );
  const owners = new Map<string, ReviewStageId>();
  const unrouted: {
    readonly majorId: string;
    readonly minorId: string;
    readonly requiredStages: readonly ReviewStageId[];
  }[] = [];
  for (const major of model.majors) {
    const owner = ownerForMajor(major, stages);
    if (owner === undefined) {
      const requiredStages = Object.freeze([
        ...(MAJOR_ROUTES[major.id]?.stages ?? []),
      ]);
      unrouted.push(
        ...major.minors.map((minor) =>
          Object.freeze({
            majorId: major.id,
            minorId: minor.id,
            requiredStages,
          }),
        ),
      );
      continue;
    }
    const target = byStage.get(owner);
    if (target === undefined) {
      throw new TypeError(`Assessment owner is not in the plan: ${owner}`);
    }
    for (const minor of major.minors) {
      if (owners.has(minor.id)) {
        throw new TypeError(`Duplicate score minor ID: ${minor.id}`);
      }
      owners.set(minor.id, owner);
      target.push(minor);
    }
  }
  return Object.freeze({
    assignments: Object.freeze(
      stages.map((stageId) =>
        Object.freeze({
          stageId,
          minors: Object.freeze([...(byStage.get(stageId) ?? [])]),
        }),
      ),
    ),
    owners,
    unrouted: Object.freeze(unrouted),
  });
}

export function minorsForStage(
  plan: ReviewAssessmentPlan,
  stageId: ReviewStageId,
): readonly ScoreMinorModel[] {
  return (
    plan.assignments.find((assignment) => assignment.stageId === stageId)
      ?.minors ?? []
  );
}

function notAssessed(
  minorId: string,
  reason: string,
  missingEvidence: string = `immutable-source-quote:${minorId}`,
): NotAssessedAssessment {
  return Object.freeze({
    minorId,
    status: "not_assessed",
    reason,
    missingEvidence: Object.freeze([missingEvidence]),
  });
}

export function unroutedAssessments(
  plan: ReviewAssessmentPlan,
): readonly NotAssessedAssessment[] {
  return Object.freeze(
    plan.unrouted.map((item) =>
      notAssessed(
        item.minorId,
        `No routed ${item.majorId} specialist stage can assess this required minor`,
        `required-stage:${item.requiredStages.join("|")}`,
      ),
    ),
  );
}

export function materializeStageAssessments(options: {
  readonly stageId: ReviewStageId;
  readonly raw: readonly StageAssessment[] | undefined;
  readonly plan: ReviewAssessmentPlan;
  readonly snapshot: ReviewSnapshot;
  readonly context?: ReviewContextBundle;
}): {
  readonly assessments: readonly Assessment[];
  readonly issues: readonly string[];
} {
  const expected = minorsForStage(options.plan, options.stageId);
  const expectedIds = new Set(expected.map((minor) => minor.id));
  const raw = options.raw ?? [];
  const extras = raw.filter((item) => !expectedIds.has(item.minorId));
  if (extras.length > 0) {
    return Object.freeze({
      assessments: Object.freeze([
        ...expected.map((minor) =>
          notAssessed(
            minor.id,
            `Stage ${options.stageId} emitted an assessment outside its ownership`,
          ),
        ),
        ...extras.map((item) =>
          notAssessed(
            item.minorId,
            `Stage ${options.stageId} emitted an unowned or unknown score minor`,
          ),
        ),
      ]),
      issues: Object.freeze([
        "Stage assessment output contained an unowned or unknown minor ID",
      ]),
    });
  }

  const byId = new Map<string, StageAssessment[]>();
  for (const assessment of raw) {
    const values = byId.get(assessment.minorId) ?? [];
    values.push(assessment);
    byId.set(assessment.minorId, values);
  }
  const verifyQuote = createImmutableSourceQuoteVerifier(
    options.snapshot,
    options.context,
  );
  const issues: string[] = [];
  const assessments = expected.map((minor): Assessment => {
    const values = byId.get(minor.id) ?? [];
    if (values.length !== 1) {
      issues.push(
        values.length === 0
          ? `Missing assessment ${minor.id}`
          : `Duplicate assessment ${minor.id}`,
      );
      return notAssessed(
        minor.id,
        values.length === 0
          ? `Stage ${options.stageId} omitted its owned assessment`
          : `Stage ${options.stageId} duplicated its owned assessment`,
      );
    }
    const assessment = values[0];
    if (assessment === undefined) {
      return notAssessed(minor.id, "The owning stage omitted this assessment");
    }
    if (assessment.status === "not_applicable") {
      const reason = assessment.reason.trim();
      if (reason.length === 0) {
        issues.push(`Invalid not-applicable reason for ${minor.id}`);
        return notAssessed(
          minor.id,
          "Assessment not-applicable reason was blank",
          `not-applicable-reason:${minor.id}`,
        );
      }
      return Object.freeze({ ...assessment, reason });
    }
    const explanation = assessment.explanation.trim();
    if (explanation.length === 0) {
      issues.push(`Invalid explanation for ${minor.id}`);
      return notAssessed(
        minor.id,
        "Assessment explanation was blank",
        `assessment-explanation:${minor.id}`,
      );
    }
    if (!assessment.evidence.every(verifyQuote)) {
      issues.push(`Invalid immutable evidence for ${minor.id}`);
      return notAssessed(
        minor.id,
        "Assessment evidence did not match its complete immutable source range",
      );
    }
    return Object.freeze({
      minorId: assessment.minorId,
      status: "scored",
      rating: assessment.rating,
      confidence: assessment.confidence,
      evidence: Object.freeze(
        assessment.evidence.map(
          (item) =>
            `${item.path}:${String(item.startLine)}-${String(item.endLine)}:${item.sourceQuote}`,
        ),
      ),
      explanation,
    });
  });
  return Object.freeze({
    assessments: Object.freeze(assessments),
    issues: Object.freeze(issues),
  });
}
