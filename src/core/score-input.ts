import {
  DEFAULT_SCORE_MODEL,
  parseScoreModelDocument,
  type BlockingFindingDisposition,
  type ScoreContext,
  type ScoreGate,
  type ScoreModel,
  type ScoreScope,
} from "./scoring.js";

const MAX_BLOCKING_FINDINGS = 1_000;
const MAX_FINDING_ID_CODE_POINTS = 256;
const ROOT_KEYS = [
  "assessments",
  "baseline",
  "context",
  "model",
  "schemaVersion",
];
const BASELINE_KEYS = ["assessments", "context", "model", "schemaVersion"];
const CONTEXT_KEYS = ["blockingFindings", "focusedDomainId", "gate", "scope"];

export class ScoreInputError extends TypeError {
  constructor(message = "Score input is invalid") {
    super(message);
    this.name = "ScoreInputError";
  }
}

export interface ParsedScoreAssessmentInput {
  readonly model: ScoreModel;
  readonly assessments: unknown;
  readonly context: ScoreContext;
}

export interface ParsedScoreInput extends ParsedScoreAssessmentInput {
  readonly baseline?: ParsedScoreAssessmentInput;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isScope(value: unknown): value is ScoreScope {
  return (
    value === "change" ||
    value === "affected_surface" ||
    value === "repository" ||
    value === "focused_domain"
  );
}

function isGate(value: unknown): value is ScoreGate {
  return (
    value === "PASS" ||
    value === "WARN" ||
    value === "BLOCK" ||
    value === "INCOMPLETE"
  );
}

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let count = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    index += codePoint > 0xffff ? 2 : 1;
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    hasAtMostCodePoints(value, MAX_FINDING_ID_CODE_POINTS)
  );
}

function parseBlockingFindings(
  value: unknown,
): readonly BlockingFindingDisposition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_BLOCKING_FINDINGS) {
    throw new ScoreInputError();
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["blocking", "confirmed", "id"]) ||
      !boundedIdentifier(entry.id) ||
      typeof entry.confirmed !== "boolean" ||
      typeof entry.blocking !== "boolean"
    ) {
      throw new ScoreInputError();
    }
    return {
      id: entry.id,
      confirmed: entry.confirmed,
      blocking: entry.blocking,
    };
  });
}

function parseContext(value: unknown): ScoreContext {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, CONTEXT_KEYS) ||
    !isScope(value.scope) ||
    !isGate(value.gate)
  ) {
    throw new ScoreInputError();
  }
  const focusedDomainId = value.focusedDomainId;
  if (focusedDomainId !== undefined && !boundedIdentifier(focusedDomainId)) {
    throw new ScoreInputError();
  }
  if ((value.scope === "focused_domain") !== (focusedDomainId !== undefined)) {
    throw new ScoreInputError();
  }
  const blockingFindings = parseBlockingFindings(value.blockingFindings);
  return {
    scope: value.scope,
    gate: value.gate,
    ...(focusedDomainId === undefined ? {} : { focusedDomainId }),
    ...(blockingFindings === undefined ? {} : { blockingFindings }),
  };
}

export function parseScoreInputDocument(source: string): ParsedScoreInput {
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    throw new ScoreInputError();
  }
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ROOT_KEYS) ||
    !("assessments" in input) ||
    !("context" in input) ||
    (input.schemaVersion !== undefined && input.schemaVersion !== "1")
  ) {
    throw new ScoreInputError();
  }
  const current = parseAssessmentInput(input, DEFAULT_SCORE_MODEL);
  const baseline =
    input.baseline === undefined
      ? undefined
      : parseAssessmentInput(input.baseline, current.model, BASELINE_KEYS);
  return {
    ...current,
    ...(baseline === undefined ? {} : { baseline }),
  };
}

function parseAssessmentInput(
  input: unknown,
  defaultModel: ScoreModel,
  allowedKeys: readonly string[] = ROOT_KEYS,
): ParsedScoreAssessmentInput {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, allowedKeys) ||
    !("assessments" in input) ||
    !("context" in input) ||
    (input.schemaVersion !== undefined && input.schemaVersion !== "1")
  ) {
    throw new ScoreInputError();
  }
  let model: ScoreModel;
  try {
    model =
      input.model === undefined
        ? defaultModel
        : parseScoreModelDocument(input.model);
  } catch {
    throw new ScoreInputError();
  }
  return {
    model,
    assessments: input.assessments,
    context: parseContext(input.context),
  };
}
