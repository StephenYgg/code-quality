import {
  DEFAULT_SCORE_MODEL,
  type Assessment,
  type ScoreContext,
  type ScoreModel,
} from "../../../src/core/scoring.js";

export const RATING_KEYS = ["0.0", "1.0", "2.0", "3.0", "4.0", "5.0"] as const;

export function assessmentsAt(rating: number): Assessment[] {
  return assessmentsForModel(DEFAULT_SCORE_MODEL, rating);
}

export function assessmentsForModel(
  model: ScoreModel,
  rating: number,
): Assessment[] {
  return model.majors.flatMap((major) =>
    major.minors.map((minor) => ({
      minorId: minor.id,
      status: "scored" as const,
      rating,
      confidence: "high" as const,
      evidence: [`src/${minor.id}.ts:1`],
      explanation: `Evidence supports a ${rating.toFixed(1)} rating.`,
    })),
  );
}

export function cloneDefaultModel(version = "2.0.0"): ScoreModel {
  return {
    ...DEFAULT_SCORE_MODEL,
    version,
    majors: DEFAULT_SCORE_MODEL.majors.map((major) => ({
      ...major,
      minors: major.minors.map((minor) => ({ ...minor })),
    })),
  };
}

export function repositoryContext(
  overrides: Partial<ScoreContext> = {},
): ScoreContext {
  return { scope: "repository", gate: "PASS", ...overrides };
}

export function updateFirstMinor(
  model: ScoreModel,
  update: (
    minor: ScoreModel["majors"][number]["minors"][number],
  ) => ScoreModel["majors"][number]["minors"][number],
): ScoreModel {
  const firstMajor = model.majors[0];
  const firstMinor = firstMajor?.minors[0];
  if (firstMajor === undefined || firstMinor === undefined) {
    throw new Error("missing first minor");
  }
  return {
    ...model,
    majors: [
      {
        ...firstMajor,
        minors: [update(firstMinor), ...firstMajor.minors.slice(1)],
      },
      ...model.majors.slice(1),
    ],
  };
}

export function modelWithFractionalRepositoryMinors(): ScoreModel {
  const model = cloneDefaultModel("fractional-2");
  const observability = model.majors.at(-1);
  const firstMinor = observability?.minors[0];
  if (observability === undefined || firstMinor === undefined) {
    throw new Error("missing observability model");
  }
  return {
    ...model,
    majors: [
      ...model.majors.slice(0, -1),
      {
        ...observability,
        minors: [
          { ...firstMinor, weightTenths: 10 },
          ...observability.minors.slice(1),
          repositoryMinor("repository-fraction-a", "Repository fraction A"),
          repositoryMinor("repository-fraction-b", "Repository fraction B"),
        ],
      },
    ],
  };
}

function repositoryMinor(id: string, name: string) {
  return {
    id,
    name,
    weightTenths: 5,
    required: false,
    domainVocabulary: [name.toLowerCase()],
    ratingAnchors: validRatingAnchors(name),
  } as const;
}

export function validRatingAnchors(label: string) {
  return {
    "0.0": `${label}: a confirmed critical failure prevents reliable review.`,
    "1.0": `${label}: severe structural gaps require author knowledge to proceed.`,
    "2.0": `${label}: key behavior remains difficult to prove and risky to change.`,
    "3.0": `${label}: material evidence gaps create measurable maintenance cost.`,
    "4.0": `${label}: evidence is strong with one small non-blocking gap.`,
    "5.0": `${label}: complete evidence proves the behavior with no material gap.`,
  } as const;
}

export function setAssessmentStatus(
  assessments: Assessment[],
  minorId: string,
  status: Assessment["status"],
): void {
  const index = assessments.findIndex((item) => item.minorId === minorId);
  if (index < 0) throw new Error(`missing assessment ${minorId}`);
  if (status === "scored") return;
  assessments[index] =
    status === "not_applicable"
      ? {
          minorId,
          status,
          reason: "This dimension is outside the declared scope.",
        }
      : {
          minorId,
          status,
          reason: "Required evidence was not collected.",
          missingEvidence: ["review evidence"],
        };
}
