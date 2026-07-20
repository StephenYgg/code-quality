import ts from "typescript";

import {
  functionKind,
  inferredFunctionName,
  isFunctionUnit,
  propertyNameText,
} from "./typescript-ast.js";
import type { AnalysisWorkTracker } from "./typescript-metrics.js";
import {
  EMPTY_ROLE_SUMMARY,
  INITIAL_FINGERPRINT,
  fingerprintHex,
  fingerprintValue,
  mixFingerprint,
  roleSummaryHex,
  summarizeStructure,
} from "./typescript-structural-summaries.js";
import type {
  Fingerprint,
  RoleSummary,
} from "./typescript-structural-summaries.js";

interface IdentityContext {
  readonly ownerId: string;
  readonly wrapperFingerprint: Fingerprint;
  readonly wrapperDepth: number;
}

interface FunctionOwner {
  readonly name: string;
  readonly symbolId: string;
}

interface StructuralIndexState {
  readonly sourceFile: ts.SourceFile;
  readonly work: AnalysisWorkTracker;
  readonly summaries: ReturnType<typeof summarizeStructure>;
  readonly identities: {
    readonly functionIds: Map<ts.FunctionLikeDeclaration, string>;
    readonly tryIds: Map<ts.TryStatement, TryStructuralIdentity>;
  };
  readonly ownership: {
    readonly contextByNode: Map<ts.Node, IdentityContext>;
    readonly functionOwnerByNode: Map<ts.Node, FunctionOwner>;
  };
  readonly ids: {
    readonly occurrences: Map<string, number>;
    readonly assignedIds: Map<string, number>;
    readonly ambiguousIds: Set<string>;
  };
}

export interface TryStructuralIdentity {
  readonly symbolId: string;
  readonly ownerName?: string;
  readonly ownerSymbolId?: string;
}

export interface StructuralIdentityIndex {
  readonly functionIds: ReadonlyMap<ts.FunctionLikeDeclaration, string>;
  readonly tryIds: ReadonlyMap<ts.TryStatement, TryStructuralIdentity>;
  readonly duplicateIds: readonly string[];
}

const ROOT_CONTEXT: IdentityContext = {
  ownerId: "",
  wrapperFingerprint: INITIAL_FINGERPRINT,
  wrapperDepth: 0,
};

export function createStructuralIdentityIndex(
  nodes: readonly ts.Node[],
  sourceFile: ts.SourceFile,
  work: AnalysisWorkTracker,
): StructuralIdentityIndex {
  const state = createStructuralIndexState(sourceFile, work, nodes);
  for (const node of nodes) indexStructuralNode(node, state);
  return {
    functionIds: state.identities.functionIds,
    tryIds: state.identities.tryIds,
    duplicateIds: [...state.ids.assignedIds]
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
      .concat([...state.ids.ambiguousIds])
      .sort(),
  };
}

function createStructuralIndexState(
  sourceFile: ts.SourceFile,
  work: AnalysisWorkTracker,
  nodes: readonly ts.Node[],
): StructuralIndexState {
  return {
    sourceFile,
    work,
    summaries: summarizeStructure(nodes, work),
    identities: { functionIds: new Map(), tryIds: new Map() },
    ownership: {
      contextByNode: new Map(),
      functionOwnerByNode: new Map(),
    },
    ids: {
      occurrences: new Map(),
      assignedIds: new Map(),
      ambiguousIds: new Set(),
    },
  };
}

function indexStructuralNode(node: ts.Node, state: StructuralIndexState): void {
  state.work.consume("structuralIdentityNodeVisits");
  const inheritedContext =
    state.ownership.contextByNode.get(node.parent) ?? ROOT_CONTEXT;
  const inheritedOwner = state.ownership.functionOwnerByNode.get(node.parent);
  const owner = indexStructuralOwner(
    node,
    inheritedContext,
    inheritedOwner,
    state,
  );
  const context = ts.isTryStatement(node)
    ? indexTryIdentity(node, inheritedContext, owner.functionOwner, state)
    : owner.context;
  state.ownership.contextByNode.set(node, context);
  if (owner.functionOwner !== undefined) {
    state.ownership.functionOwnerByNode.set(node, owner.functionOwner);
  }
}

function indexStructuralOwner(
  node: ts.Node,
  inheritedContext: IdentityContext,
  inheritedOwner: FunctionOwner | undefined,
  state: StructuralIndexState,
): {
  readonly context: IdentityContext;
  readonly functionOwner?: FunctionOwner;
} {
  const ownerBase = structuralOwnerBase(
    node,
    state.sourceFile,
    state.summaries.targetRoleSummaries,
    state.summaries.fingerprints,
    state.work,
  );
  if (ownerBase === undefined) {
    const wrapperBase = state.summaries.relevantNodes.has(node)
      ? structuralWrapperBase(node, state.summaries.fingerprints)
      : undefined;
    return {
      context:
        wrapperBase === undefined
          ? inheritedContext
          : appendWrapperContext(
              inheritedContext,
              wrapperBase,
              state.ids.occurrences,
              state.work,
            ),
      ...(inheritedOwner === undefined
        ? {}
        : { functionOwner: inheritedOwner }),
    };
  }
  const symbolId = nextStructuralId(
    identityPrefix(inheritedContext),
    ownerBase,
    state.ids.occurrences,
    state.work,
    isFunctionUnit(node) || state.summaries.relevantNodes.has(node)
      ? state.ids.ambiguousIds
      : undefined,
  );
  recordAssignedId(symbolId, state.ids.assignedIds);
  if (!isFunctionUnit(node)) {
    return {
      context: { ...ROOT_CONTEXT, ownerId: symbolId },
      ...(inheritedOwner === undefined
        ? {}
        : { functionOwner: inheritedOwner }),
    };
  }
  state.identities.functionIds.set(node, symbolId);
  return {
    context: { ...ROOT_CONTEXT, ownerId: symbolId },
    functionOwner: {
      name: inferredFunctionName(node, state.sourceFile),
      symbolId,
    },
  };
}

function indexTryIdentity(
  node: ts.TryStatement,
  inheritedContext: IdentityContext,
  functionOwner: FunctionOwner | undefined,
  state: StructuralIndexState,
): IdentityContext {
  const role =
    state.summaries.targetRoleSummaries.get(node) ?? EMPTY_ROLE_SUMMARY;
  const symbolId = nextStructuralId(
    identityPrefix(inheritedContext, true),
    `try:${roleSummaryHex(role)}`,
    state.ids.occurrences,
    state.work,
    state.ids.ambiguousIds,
  );
  recordAssignedId(symbolId, state.ids.assignedIds);
  state.identities.tryIds.set(node, {
    symbolId,
    ...(functionOwner === undefined
      ? {}
      : {
          ownerName: functionOwner.name,
          ownerSymbolId: functionOwner.symbolId,
        }),
  });
  return appendWrapperContext(
    inheritedContext,
    `try:${symbolId}`,
    state.ids.occurrences,
    state.work,
  );
}

function identityPrefix(
  context: IdentityContext,
  moduleFallback = false,
): string {
  const wrapper =
    context.wrapperDepth === 0
      ? ""
      : `context:${fingerprintHex(context.wrapperFingerprint)}`;
  if (context.ownerId.length === 0)
    return wrapper || (moduleFallback ? "module" : "");
  return wrapper.length === 0
    ? context.ownerId
    : `${context.ownerId}/${wrapper}`;
}

function appendWrapperContext(
  context: IdentityContext,
  base: string,
  occurrences: Map<string, number>,
  work: AnalysisWorkTracker,
): IdentityContext {
  work.consume(
    "structuralPathTextUnits",
    identityPrefix(context).length + base.length + 24,
  );
  const occurrenceKey = `${identityPrefix(context)}\u0000wrapper:${base}`;
  const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
  occurrences.set(occurrenceKey, occurrence);
  work.consume("structuralPathOperations");
  const token = `${base}#${String(occurrence)}`;
  let wrapperFingerprint = context.wrapperFingerprint;
  for (let index = 0; index < token.length; index += 1) {
    wrapperFingerprint = mixFingerprint(
      wrapperFingerprint,
      token.charCodeAt(index),
    );
  }
  return {
    ownerId: context.ownerId,
    wrapperFingerprint,
    wrapperDepth: context.wrapperDepth + 1,
  };
}

function nextStructuralId(
  parentPath: string,
  base: string,
  occurrences: Map<string, number>,
  work: AnalysisWorkTracker,
  ambiguousIds?: Set<string>,
): string {
  work.consume("structuralPathTextUnits", parentPath.length + base.length + 24);
  const key = `${parentPath}\u0000${base}`;
  const occurrence = (occurrences.get(key) ?? 0) + 1;
  occurrences.set(key, occurrence);
  if (occurrence > 1 && ambiguousIds !== undefined) {
    ambiguousIds.add(parentPath.length === 0 ? base : `${parentPath}/${base}`);
  }
  work.consume("structuralPathOperations");
  const segment = `${base}#${String(occurrence)}`;
  return parentPath.length === 0 ? segment : `${parentPath}/${segment}`;
}

function recordAssignedId(id: string, assignedIds: Map<string, number>): void {
  assignedIds.set(id, (assignedIds.get(id) ?? 0) + 1);
}

function structuralOwnerBase(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  targetRoleSummaries: ReadonlyMap<ts.Node, RoleSummary>,
  fingerprints: ReadonlyMap<ts.Node, Fingerprint>,
  work: AnalysisWorkTracker,
): string | undefined {
  if (isFunctionUnit(node)) {
    const inferredName = inferredFunctionName(node, sourceFile);
    const name = inferredName.replace(/^<anonymous@\d+:\d+>$/u, "<anonymous>");
    const base = `${functionIdentityRole(node)}:${name}`;
    if (name !== "<anonymous>") return base;
    const role = targetRoleSummaries.get(node) ?? EMPTY_ROLE_SUMMARY;
    return `${base}:${roleSummaryHex(role)}:${nodeFingerprint(node, fingerprints)}`;
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return `class:${className(node)}`;
  }
  if (ts.isModuleDeclaration(node)) return moduleBase(node);
  if (ts.isObjectLiteralExpression(node)) {
    return objectIdentityBase(node, sourceFile, fingerprints, work);
  }
  return undefined;
}

function functionIdentityRole(node: ts.FunctionLikeDeclaration): string {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const staticPrefix = hasStaticModifier(node) ? "static-" : "";
  if (ts.isGetAccessorDeclaration(node)) return `${staticPrefix}getter`;
  if (ts.isSetAccessorDeclaration(node)) return `${staticPrefix}setter`;
  if (ts.isMethodDeclaration(node)) return `${staticPrefix}method`;
  return functionKind(node);
}

function hasStaticModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ===
      true
  );
}

function structuralWrapperBase(
  node: ts.Node,
  fingerprints: ReadonlyMap<ts.Node, Fingerprint>,
): string | undefined {
  if (ts.isCallExpression(node)) {
    return `call:${nodeFingerprint(node, fingerprints)}`;
  }
  if (ts.isIfStatement(node)) {
    return `if:${nodeFingerprint(node.expression, fingerprints)}`;
  }
  if (ts.isSwitchStatement(node)) {
    return `switch:${nodeFingerprint(node.expression, fingerprints)}`;
  }
  if (ts.isCaseClause(node)) {
    return `case:${nodeFingerprint(node.expression, fingerprints)}`;
  }
  if (ts.isCatchClause(node)) return "catch";
  if (ts.isBlock(node)) return blockRole(node);
  return undefined;
}

function nodeFingerprint(
  node: ts.Node,
  fingerprints: ReadonlyMap<ts.Node, Fingerprint>,
): string {
  return fingerprintHex(fingerprintValue(node, fingerprints));
}

function blockRole(node: ts.Block): string | undefined {
  const parent = node.parent;
  if (isFunctionUnit(parent) || ts.isModuleBlock(parent)) return undefined;
  if (ts.isIfStatement(parent)) {
    return node === parent.thenStatement ? "branch:then" : "branch:else";
  }
  if (ts.isTryStatement(parent)) {
    if (node === parent.tryBlock) return "try-body";
    if (node === parent.finallyBlock) return "finally";
  }
  if (ts.isSourceFile(parent)) return undefined;
  return undefined;
}

function className(node: ts.ClassLikeDeclaration): string {
  if (node.name !== undefined) return node.name.text;
  if (
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return "<anonymous>";
}

function moduleBase(node: ts.ModuleDeclaration): string {
  const kind =
    (node.flags & ts.NodeFlags.Namespace) !== 0 ? "namespace" : "module";
  return `${kind}:${node.name.text}`;
}

function objectName(
  node: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
): string {
  if (
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  if (ts.isPropertyAssignment(node.parent)) {
    return propertyNameText(node.parent.name, sourceFile);
  }
  return "<anonymous>";
}

function objectIdentityBase(
  node: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  fingerprints: ReadonlyMap<ts.Node, Fingerprint>,
  work: AnalysisWorkTracker,
): string {
  const name = objectName(node, sourceFile);
  if (name !== "<anonymous>") return `object:${name}`;

  let fingerprint = INITIAL_FINGERPRINT;
  for (const property of node.properties) {
    work.consume("structuralRoleOperations");
    const role = objectPropertyRole(property, sourceFile, fingerprints);
    work.consume("structuralPathTextUnits", role.length);
    for (let index = 0; index < role.length; index += 1) {
      fingerprint = mixFingerprint(fingerprint, role.charCodeAt(index));
    }
  }
  return `object:<anonymous>:${fingerprintHex(fingerprint)}`;
}

function objectPropertyRole(
  property: ts.ObjectLiteralElementLike,
  sourceFile: ts.SourceFile,
  fingerprints: ReadonlyMap<ts.Node, Fingerprint>,
): string {
  if (ts.isSpreadAssignment(property)) {
    return `spread:${nodeFingerprint(property.expression, fingerprints)}`;
  }
  const name = propertyNameText(property.name, sourceFile);
  if (ts.isShorthandPropertyAssignment(property)) {
    return `${String(property.kind)}:${name}`;
  }
  const value = ts.isPropertyAssignment(property)
    ? property.initializer
    : property;
  return `${String(property.kind)}:${name}:${nodeFingerprint(value, fingerprints)}`;
}
