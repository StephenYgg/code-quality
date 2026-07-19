import { validatePolicyDocumentStructure } from "./policy-structure.js";
import { deepFreezeScoreModel, validateScoreModel } from "./scoring-model.js";
import type {
  RatingAnchors,
  ScoreIssue,
  ScoreMajorModel,
  ScoreMinorModel,
  ScoreModel,
} from "./scoring-types.js";

export class ScoreModelDocumentError extends TypeError {
  readonly issues: readonly ScoreIssue[];

  constructor(kind: "schema" | "semantic", issues: readonly ScoreIssue[]) {
    super(`Score model document failed ${kind} validation`);
    this.name = "ScoreModelDocumentError";
    this.issues = Object.freeze([...issues]);
  }
}

export function parseScoreModelDocument(input: unknown): ScoreModel {
  const structuralDiagnostics = validatePolicyDocumentStructure(
    "score-model",
    input,
    "score-model",
  );
  if (structuralDiagnostics.length > 0) {
    throw new ScoreModelDocumentError(
      "schema",
      structuralDiagnostics.map((diagnostic) => ({
        code: "INVALID_DOCUMENT_STRUCTURE",
        path: diagnostic.path,
        message: diagnostic.message,
      })),
    );
  }

  const model = materializeScoreModel(input);
  if (model === undefined) {
    throw new ScoreModelDocumentError("schema", [invalidStructureIssue()]);
  }
  const semanticIssues = validateScoreModel(model);
  if (semanticIssues.length > 0) {
    throw new ScoreModelDocumentError("semantic", semanticIssues);
  }
  return deepFreezeScoreModel(model);
}

export function validateScoreModelDocumentSemantics(
  input: unknown,
): readonly ScoreIssue[] {
  const model = materializeScoreModel(input);
  return model === undefined
    ? [invalidStructureIssue()]
    : validateScoreModel(model);
}

function materializeScoreModel(input: unknown): ScoreModel | undefined {
  if (!isRecord(input)) return undefined;
  const id = stringProperty(input, "id");
  const version = stringProperty(input, "version");
  const profileHashValue = input.profileHash;
  const roundingMode = stringProperty(input, "roundingMode");
  const ruleVersions = materializeRuleVersions(input.ruleVersions);
  const majorsValue = input.majors;
  if (
    id === undefined ||
    version === undefined ||
    (profileHashValue !== undefined && typeof profileHashValue !== "string") ||
    roundingMode === undefined ||
    ruleVersions === undefined ||
    !Array.isArray(majorsValue)
  ) {
    return undefined;
  }

  const majors: ScoreMajorModel[] = [];
  for (const value of majorsValue) {
    const major = materializeMajor(value);
    if (major === undefined) return undefined;
    majors.push(major);
  }
  return {
    id,
    version,
    ...(profileHashValue === undefined
      ? {}
      : { profileHash: profileHashValue }),
    ruleVersions,
    roundingMode,
    majors,
  };
}

function materializeRuleVersions(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, version] of Object.entries(value)) {
    if (typeof version !== "string") return undefined;
    result[key] = version;
  }
  return result;
}

function materializeMajor(value: unknown): ScoreMajorModel | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringProperty(value, "id");
  const name = stringProperty(value, "name");
  const weightTenths = numberProperty(value, "weightTenths");
  const minorsValue = value.minors;
  if (
    id === undefined ||
    name === undefined ||
    weightTenths === undefined ||
    !Array.isArray(minorsValue)
  ) {
    return undefined;
  }
  const minors: ScoreMinorModel[] = [];
  for (const minorValue of minorsValue) {
    const minor = materializeMinor(minorValue);
    if (minor === undefined) return undefined;
    minors.push(minor);
  }
  return { id, name, weightTenths, minors };
}

function materializeMinor(value: unknown): ScoreMinorModel | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringProperty(value, "id");
  const name = stringProperty(value, "name");
  const weightTenths = numberProperty(value, "weightTenths");
  const required = value.required;
  const domainVocabulary = value.domainVocabulary;
  const ratingAnchors = value.ratingAnchors;
  if (
    id === undefined ||
    name === undefined ||
    weightTenths === undefined ||
    typeof required !== "boolean" ||
    !isStringArray(domainVocabulary) ||
    !isRecord(ratingAnchors)
  ) {
    return undefined;
  }
  return {
    id,
    name,
    weightTenths,
    required,
    domainVocabulary: [...domainVocabulary],
    ratingAnchors: { ...ratingAnchors } as unknown as RatingAnchors,
  };
}

function stringProperty(
  value: Readonly<Record<string, unknown>>,
  property: string,
): string | undefined {
  const result = value[property];
  return typeof result === "string" ? result : undefined;
}

function numberProperty(
  value: Readonly<Record<string, unknown>>,
  property: string,
): number | undefined {
  const result = value[property];
  return typeof result === "number" ? result : undefined;
}

function invalidStructureIssue(): ScoreIssue {
  return {
    code: "INVALID_DOCUMENT_STRUCTURE",
    path: "",
    message: "Score model semantics require a structurally valid document",
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  const entries: readonly unknown[] = value;
  return entries.every((entry) => typeof entry === "string");
}
