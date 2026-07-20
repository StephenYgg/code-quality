import type { ScoreModelSelection } from "../core/policy-types.js";
import { canonicalizePolicy, policySha256 } from "../core/policy-values.js";
import {
  deepFreezeScoreModel,
  DEFAULT_SCORE_MODEL,
  validateScoreModel,
} from "../core/scoring-model.js";
import type { ScoreModel } from "../core/scoring-types.js";

const DEFAULT_MODEL_ALIASES = new Set(["cq-default", "cq-default-100"]);

export class ProfileScoreModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileScoreModelError";
  }
}

export function scoreModelFingerprint(model: ScoreModel): string {
  return policySha256(
    `cq-score-model-fingerprint/v1\0${canonicalizePolicy(model)}`,
  );
}

function weightTenths(value: number, label: string): number {
  const tenths = value * 10;
  if (!Number.isFinite(value) || !Number.isInteger(tenths)) {
    throw new ProfileScoreModelError(
      `${label} must be an absolute weight with one decimal place`,
    );
  }
  return tenths;
}

function assertKnownIds(
  values: Readonly<Record<string, number>> | undefined,
  known: ReadonlySet<string>,
  kind: string,
): void {
  for (const id of Object.keys(values ?? {})) {
    if (!known.has(id)) {
      throw new ProfileScoreModelError(`Unknown score ${kind} ID: ${id}`);
    }
  }
}

function selectedWeight(
  values: Readonly<Record<string, number>> | undefined,
  id: string,
  fallback: number,
  label: string,
): number {
  const value = values?.[id];
  return value === undefined ? fallback : weightTenths(value, label);
}

export function materializeProfileScoreModel(
  selection: ScoreModelSelection | undefined,
  profileHash: string,
): ScoreModel {
  if (selection?.id !== undefined && !DEFAULT_MODEL_ALIASES.has(selection.id)) {
    throw new ProfileScoreModelError(`Unknown score model ID: ${selection.id}`);
  }
  const hasOverrides =
    Object.keys(selection?.majorWeights ?? {}).length > 0 ||
    Object.keys(selection?.minorWeights ?? {}).length > 0;
  if (!hasOverrides) return DEFAULT_SCORE_MODEL;
  if (profileHash.trim().length === 0) {
    throw new ProfileScoreModelError(
      "Profile hash is required for score overrides",
    );
  }

  const majorIds = new Set(DEFAULT_SCORE_MODEL.majors.map((major) => major.id));
  const minorIds = new Set(
    DEFAULT_SCORE_MODEL.majors.flatMap((major) =>
      major.minors.map((minor) => minor.id),
    ),
  );
  assertKnownIds(selection?.majorWeights, majorIds, "major");
  assertKnownIds(selection?.minorWeights, minorIds, "minor");

  const model: ScoreModel = {
    ...DEFAULT_SCORE_MODEL,
    version: `${DEFAULT_SCORE_MODEL.version}+profile.${profileHash.slice(0, 12)}`,
    profileHash,
    ruleVersions: { ...DEFAULT_SCORE_MODEL.ruleVersions },
    majors: DEFAULT_SCORE_MODEL.majors.map((major) => ({
      ...major,
      weightTenths: selectedWeight(
        selection?.majorWeights,
        major.id,
        major.weightTenths,
        `Major ${major.id}`,
      ),
      minors: major.minors.map((minor) => ({
        ...minor,
        weightTenths: selectedWeight(
          selection?.minorWeights,
          minor.id,
          minor.weightTenths,
          `Minor ${minor.id}`,
        ),
        domainVocabulary: [...minor.domainVocabulary],
        ratingAnchors: { ...minor.ratingAnchors },
      })),
    })),
  };
  const issues = validateScoreModel(model);
  if (issues.length > 0) {
    throw new ProfileScoreModelError(
      `Invalid score model override: ${issues[0]?.message ?? "unknown failure"}`,
    );
  }
  return deepFreezeScoreModel(model);
}
