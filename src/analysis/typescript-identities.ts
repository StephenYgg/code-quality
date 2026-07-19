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
  const summaries = summarizeStructure(nodes, work);
  const functionIds = new Map<ts.FunctionLikeDeclaration, string>();
  const tryIds = new Map<ts.TryStatement, TryStructuralIdentity>();
  const contextByNode = new Map<ts.Node, IdentityContext>();
  const functionOwnerByNode = new Map<ts.Node, FunctionOwner>();
  const occurrences = new Map<string, number>();
  const assignedIds = new Map<string, number>();
  const ambiguousIds = new Set<string>();

  for (const node of nodes) {
    work.consume("structuralIdentityNodeVisits");
    const inheritedContext = contextByNode.get(node.parent) ?? ROOT_CONTEXT;
    const inheritedOwner = functionOwnerByNode.get(node.parent);
    let context = inheritedContext;
    let functionOwner = inheritedOwner;
    const ownerBase = structuralOwnerBase(
      node,
      sourceFile,
      summaries.targetRoleSummaries,
    );

    if (ownerBase !== undefined) {
      const symbolId = nextStructuralId(
        identityPrefix(inheritedContext),
        ownerBase,
        occurrences,
        work,
        isFunctionUnit(node) || summaries.relevantNodes.has(node)
          ? ambiguousIds
          : undefined,
      );
      recordAssignedId(symbolId, assignedIds);
      context = { ...ROOT_CONTEXT, ownerId: symbolId };
      if (isFunctionUnit(node)) {
        functionIds.set(node, symbolId);
        functionOwner = {
          name: inferredFunctionName(node, sourceFile),
          symbolId,
        };
      }
    } else if (summaries.relevantNodes.has(node)) {
      const wrapperBase = structuralWrapperBase(node, summaries.fingerprints);
      if (wrapperBase !== undefined) {
        context = appendWrapperContext(
          inheritedContext,
          wrapperBase,
          occurrences,
          work,
        );
      }
    }

    if (ts.isTryStatement(node)) {
      const role =
        summaries.targetRoleSummaries.get(node) ?? EMPTY_ROLE_SUMMARY;
      const tryBase = `try:${roleSummaryHex(role)}`;
      const symbolId = nextStructuralId(
        identityPrefix(inheritedContext, true),
        tryBase,
        occurrences,
        work,
        ambiguousIds,
      );
      recordAssignedId(symbolId, assignedIds);
      tryIds.set(node, {
        symbolId,
        ...(functionOwner === undefined
          ? {}
          : {
              ownerName: functionOwner.name,
              ownerSymbolId: functionOwner.symbolId,
            }),
      });
      context = appendWrapperContext(
        inheritedContext,
        `try:${symbolId}`,
        occurrences,
        work,
      );
    }

    contextByNode.set(node, context);
    if (functionOwner !== undefined)
      functionOwnerByNode.set(node, functionOwner);
  }

  return {
    functionIds,
    tryIds,
    duplicateIds: [...assignedIds]
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
      .concat([...ambiguousIds])
      .sort(),
  };
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
): string | undefined {
  if (isFunctionUnit(node)) {
    const inferredName = inferredFunctionName(node, sourceFile);
    const name = inferredName.replace(/^<anonymous@\d+:\d+>$/u, "<anonymous>");
    const base = `${functionIdentityRole(node)}:${name}`;
    if (name !== "<anonymous>") return base;
    const role = targetRoleSummaries.get(node) ?? EMPTY_ROLE_SUMMARY;
    return `${base}:${roleSummaryHex(role)}`;
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return `class:${className(node)}`;
  }
  if (ts.isModuleDeclaration(node)) return moduleBase(node);
  if (ts.isObjectLiteralExpression(node)) {
    return `object:${objectName(node, sourceFile)}`;
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
    return `call:${nodeFingerprint(node.expression, fingerprints)}`;
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
