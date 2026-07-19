import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Ajv2020,
  type AnySchemaObject,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import { compareCodeUnits } from "./deterministic-order.js";
import {
  diagnosticLimitNotice,
  MAX_POLICY_DIAGNOSTICS_PER_DOCUMENT,
} from "./policy-diagnostics.js";
import type { PolicyDiagnostic, PolicyDocumentKind } from "./policy-types.js";

export const POLICY_PROJECT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SCHEMA_FILES: Readonly<Record<PolicyDocumentKind, string>> = {
  finding: "finding.schema.json",
  profile: "profile.schema.json",
  rule: "rule.schema.json",
  run: "run.schema.json",
  "score-model": "score-model.schema.json",
  waiver: "waiver.schema.json",
};

export interface ValidatedDocument<T> {
  readonly value?: T;
  readonly diagnostics: readonly PolicyDiagnostic[];
}

export type PolicyDocumentValidator<T> = (
  document: unknown,
  source: string,
) => ValidatedDocument<T>;

function isSchemaObject(value: unknown): value is AnySchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaObject(kind: PolicyDocumentKind): AnySchemaObject {
  const path = join(POLICY_PROJECT_ROOT, "schemas", SCHEMA_FILES[kind]);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isSchemaObject(parsed)) {
    throw new Error(`Schema ${SCHEMA_FILES[kind]} is not an object`);
  }
  return parsed;
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unknownProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const property: unknown = Reflect.get(value, key);
  return property;
}

function diagnosticPath(error: ErrorObject): string {
  if (error.keyword === "additionalProperties") {
    const property = unknownProperty(error.params, "additionalProperty");
    return typeof property === "string"
      ? `${error.instancePath}/${escapeJsonPointer(property)}`
      : error.instancePath;
  }
  if (error.keyword === "required") {
    const property = unknownProperty(error.params, "missingProperty");
    return typeof property === "string"
      ? `${error.instancePath}/${escapeJsonPointer(property)}`
      : error.instancePath;
  }
  return error.instancePath;
}

export function comparePolicyDiagnostics(
  left: PolicyDiagnostic,
  right: PolicyDiagnostic,
): number {
  return (
    compareCodeUnits(left.source, right.source) ||
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.code, right.code) ||
    compareCodeUnits(left.message, right.message)
  );
}

export function limitPolicyDiagnostics(
  diagnostics: readonly PolicyDiagnostic[],
  source: string,
): PolicyDiagnostic[] {
  const truncated = diagnostics.length > MAX_POLICY_DIAGNOSTICS_PER_DOCUMENT;
  const retained = diagnostics
    .slice(
      0,
      truncated
        ? MAX_POLICY_DIAGNOSTICS_PER_DOCUMENT - 1
        : MAX_POLICY_DIAGNOSTICS_PER_DOCUMENT,
    )
    .sort(comparePolicyDiagnostics);
  if (truncated) {
    retained.push(diagnosticLimitNotice(source));
  }
  return retained;
}

function schemaDiagnostics(
  errors: readonly ErrorObject[],
  source: string,
): PolicyDiagnostic[] {
  const retainedCount =
    errors.length > MAX_POLICY_DIAGNOSTICS_PER_DOCUMENT
      ? MAX_POLICY_DIAGNOSTICS_PER_DOCUMENT - 1
      : errors.length;
  const diagnostics = errors.slice(0, retainedCount).map((error) => ({
    code: "SCHEMA_INVALID",
    source,
    path: diagnosticPath(error),
    message: error.message ?? `Schema keyword ${error.keyword} failed`,
  }));
  if (errors.length > MAX_POLICY_DIAGNOSTICS_PER_DOCUMENT) {
    diagnostics.push(diagnosticLimitNotice(source));
  }
  return diagnostics.sort(comparePolicyDiagnostics);
}

function isValidated<T>(
  validate: ValidateFunction<T>,
  value: unknown,
): value is T {
  return validate(value);
}

export function createPolicyDocumentStructureValidator<T>(
  kind: PolicyDocumentKind,
): PolicyDocumentValidator<T> {
  const ajv = new Ajv2020({ allErrors: false, strict: true });
  const validate = ajv.compile<T>(schemaObject(kind));
  return (document, source) => {
    if (!isValidated(validate, document)) {
      return { diagnostics: schemaDiagnostics(validate.errors ?? [], source) };
    }
    return { value: document, diagnostics: [] };
  };
}

export function validatePolicyDocumentStructure(
  kind: PolicyDocumentKind,
  document: unknown,
  source = "<memory>",
): readonly PolicyDiagnostic[] {
  return createPolicyDocumentStructureValidator(kind)(document, source)
    .diagnostics;
}
