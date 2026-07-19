import {
  StructuredConfigError,
  loadStructuredFile,
  type StructuredReadBudget,
  type StructuredSource,
} from "./config.js";
import {
  createPolicyDocumentStructureValidator,
  limitPolicyDiagnostics,
  type PolicyDocumentValidator,
  type ValidatedDocument,
} from "./policy-structure.js";
import { validateScoreModelDocumentSemantics } from "./score-model-document.js";
import type {
  PolicyDiagnostic,
  PolicyDocumentKind,
  PolicyLayer,
  ProfileDocument,
} from "./policy-types.js";

export {
  comparePolicyDiagnostics,
  POLICY_PROJECT_ROOT,
  validatePolicyDocumentStructure,
} from "./policy-structure.js";
export type {
  PolicyDocumentValidator,
  ValidatedDocument,
} from "./policy-structure.js";

export interface LoadedDocument<T> extends ValidatedDocument<T> {
  readonly structuredSource?: StructuredSource;
}

export function validateDocument<T>(
  kind: PolicyDocumentKind,
  document: unknown,
  source: string,
): ValidatedDocument<T> {
  return createPolicyDocumentValidator<T>(kind)(document, source);
}

export function createPolicyDocumentValidator<T>(
  kind: PolicyDocumentKind,
): PolicyDocumentValidator<T> {
  const validateStructure = createPolicyDocumentStructureValidator<T>(kind);
  return (document, source) => {
    const structural = validateStructure(document, source);
    if (structural.value === undefined) {
      return structural;
    }
    const semanticDiagnostics =
      kind === "score-model"
        ? scoreModelSemanticDiagnostics(structural.value, source)
        : [];
    return semanticDiagnostics.length > 0
      ? { diagnostics: semanticDiagnostics }
      : structural;
  };
}

function scoreIssuePath(path: string): string {
  if (path.length === 0) {
    return "";
  }
  const pointer = path
    .replace(/\[(?<index>[0-9]+)\]/gu, "/$<index>")
    .replaceAll("[]", "")
    .replaceAll(".", "/");
  return `/${pointer}`;
}

function scoreModelSemanticDiagnostics(
  document: unknown,
  source: string,
): PolicyDiagnostic[] {
  const issues = validateScoreModelDocumentSemantics(document);
  return limitPolicyDiagnostics(
    issues.map((issue) => ({
      code: issue.code,
      source,
      path: scoreIssuePath(issue.path),
      message: issue.message,
    })),
    source,
  );
}

export function validatePolicyDocument(
  kind: PolicyDocumentKind,
  document: unknown,
  source = "<memory>",
): readonly PolicyDiagnostic[] {
  return validateDocument(kind, document, source).diagnostics;
}

export function configDiagnostic(
  error: StructuredConfigError,
): PolicyDiagnostic {
  const base = {
    code: error.code,
    source: error.source,
    path: error.path,
    message: error.message,
  };
  const withLine =
    error.line === undefined ? base : { ...base, line: error.line };
  return error.column === undefined
    ? withLine
    : { ...withLine, column: error.column };
}

export async function loadPolicyDocument<T>(
  kind: PolicyDocumentKind,
  path: string,
  source: string,
  containmentRoot: string,
  budget: StructuredReadBudget,
): Promise<LoadedDocument<T>> {
  try {
    const structuredSource = await loadStructuredFile(path, {
      containmentRoot,
      source,
      budget,
    });
    const validated = validateDocument<T>(kind, structuredSource.data, source);
    return { ...validated, structuredSource };
  } catch (error) {
    if (error instanceof StructuredConfigError) {
      return { diagnostics: [configDiagnostic(error)] };
    }
    throw error;
  }
}

function layerAsProfile(layer: PolicyLayer): unknown {
  return {
    schemaVersion: "1",
    id: "runtime-layer",
    version: 1,
    rulePacks: ["builtin:universal"],
    ...layer,
  };
}

export function validatePolicyLayer(
  layer: PolicyLayer,
  source: string,
): readonly PolicyDiagnostic[] {
  return validateDocument<ProfileDocument>(
    "profile",
    layerAsProfile(layer),
    source,
  ).diagnostics;
}
