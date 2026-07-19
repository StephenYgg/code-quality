import ts from "typescript";

import { childNodes, isFunctionUnit } from "./typescript-ast.js";
import type { AnalysisWorkTracker } from "./typescript-metrics.js";

const HASH_A_OFFSET = 0x811c9dc5;
const HASH_B_OFFSET = 0x9e3779b9;
const HASH_A_PRIME = 0x01000193;
const HASH_B_PRIME = 0x85ebca6b;

export interface Fingerprint {
  readonly a: number;
  readonly b: number;
}

export interface RoleSummary extends Fingerprint {
  readonly count: number;
}

export interface StructuralSummaries {
  readonly fingerprints: ReadonlyMap<ts.Node, Fingerprint>;
  readonly targetRoleSummaries: ReadonlyMap<ts.Node, RoleSummary>;
  readonly relevantNodes: ReadonlySet<ts.Node>;
}

export const INITIAL_FINGERPRINT: Fingerprint = {
  a: HASH_A_OFFSET,
  b: HASH_B_OFFSET,
};

export const EMPTY_ROLE_SUMMARY: RoleSummary = { a: 0, b: 0, count: 0 };

export function summarizeStructure(
  nodes: readonly ts.Node[],
  work: AnalysisWorkTracker,
): StructuralSummaries {
  const fingerprints = new Map<ts.Node, Fingerprint>();
  const exportedRoleSummaries = new Map<ts.Node, RoleSummary>();
  const targetRoleSummaries = new Map<ts.Node, RoleSummary>();
  const relevantNodes = new Set<ts.Node>();
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    work.consume("structuralFingerprintNodeVisits");
    let fingerprint = fingerprintNode(node, work);
    let roleSummary = EMPTY_ROLE_SUMMARY;
    let relevant = isFunctionUnit(node) || ts.isTryStatement(node);
    for (const child of childNodes(node)) {
      work.consume("structuralIdentityEdgeVisits");
      const childFingerprint = fingerprints.get(child);
      if (childFingerprint !== undefined) {
        fingerprint = combineFingerprint(fingerprint, childFingerprint);
      }
      roleSummary = combineRoleSummaries(
        roleSummary,
        exportedRoleSummaries.get(child) ?? EMPTY_ROLE_SUMMARY,
      );
      if (relevantNodes.has(child)) relevant = true;
    }
    fingerprints.set(node, fingerprint);
    const operationRole = semanticOperationRole(node, fingerprints, work);
    if (operationRole !== undefined) {
      roleSummary = combineRoleSummaries(roleSummary, operationRole);
    }
    if (ts.isTryStatement(node)) {
      roleSummary = combineRoleSummaries(
        roleSummary,
        tryBoundaryRole(node, work),
      );
    }
    if (isStructuralBoundary(node)) {
      targetRoleSummaries.set(node, roleSummary);
      exportedRoleSummaries.set(node, EMPTY_ROLE_SUMMARY);
    } else {
      exportedRoleSummaries.set(node, roleSummary);
    }
    if (relevant) relevantNodes.add(node);
  }
  return { fingerprints, targetRoleSummaries, relevantNodes };
}

export function fingerprintValue(
  node: ts.Node,
  fingerprints: ReadonlyMap<ts.Node, Fingerprint>,
): Fingerprint {
  return fingerprints.get(node) ?? INITIAL_FINGERPRINT;
}

export function fingerprintHex(value: Fingerprint): string {
  return `${value.a.toString(16).padStart(8, "0")}${value.b
    .toString(16)
    .padStart(8, "0")}`;
}

export function roleSummaryHex(summary: RoleSummary): string {
  return `${fingerprintHex(summary)}${summary.count.toString(16).padStart(8, "0")}`;
}

export function mixFingerprint(
  current: Fingerprint,
  value: number,
): Fingerprint {
  return {
    a: Math.imul(current.a ^ value, HASH_A_PRIME) >>> 0,
    b: Math.imul(current.b ^ value, HASH_B_PRIME) >>> 0,
  };
}

function summarizeRoleValues(
  values: readonly number[],
  work: AnalysisWorkTracker,
): RoleSummary {
  work.consume("structuralRoleOperations", values.length);
  let fingerprint = INITIAL_FINGERPRINT;
  for (const value of values) {
    fingerprint = mixFingerprint(fingerprint, value);
  }
  return { ...fingerprint, count: 1 };
}

function combineRoleSummaries(
  left: RoleSummary,
  right: RoleSummary,
): RoleSummary {
  return {
    a: (left.a + right.a) >>> 0,
    b: (left.b + right.b) >>> 0,
    count: left.count + right.count,
  };
}

function isStructuralBoundary(node: ts.Node): boolean {
  return (
    isFunctionUnit(node) ||
    ts.isTryStatement(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isObjectLiteralExpression(node)
  );
}

function semanticOperationRole(
  node: ts.Node,
  fingerprints: ReadonlyMap<ts.Node, Fingerprint>,
  work: AnalysisWorkTracker,
): RoleSummary | undefined {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    return summarizeNodeRole(node.kind, node.expression, fingerprints, work);
  }
  if (
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    ts.isThrowStatement(node) ||
    ts.isCatchClause(node)
  ) {
    return summarizeRoleValues([node.kind], work);
  }
  if (ts.isDeleteExpression(node)) {
    return summarizeNodeRole(node.kind, node.expression, fingerprints, work);
  }
  if (ts.isPropertyAccessExpression(node)) {
    const fingerprint = fingerprintValue(node, fingerprints);
    return summarizeRoleValues(
      [
        node.kind,
        node.questionDotToken === undefined ? 0 : 1,
        fingerprint.a,
        fingerprint.b,
      ],
      work,
    );
  }
  if (ts.isElementAccessExpression(node)) {
    const expression = fingerprintValue(node.expression, fingerprints);
    const argument = stableOperandFingerprint(
      node.argumentExpression,
      fingerprints,
    );
    return summarizeRoleValues(
      [node.kind, expression.a, expression.b, argument.a, argument.b],
      work,
    );
  }
  if (
    ts.isBinaryExpression(node) &&
    isAssignmentOperator(node.operatorToken.kind)
  ) {
    const left = fingerprintValue(node.left, fingerprints);
    return summarizeRoleValues(
      [node.kind, node.operatorToken.kind, left.a, left.b],
      work,
    );
  }
  if (
    ts.isBinaryExpression(node) &&
    isComparisonOperator(node.operatorToken.kind)
  ) {
    const left = stableOperandFingerprint(node.left, fingerprints);
    const right = stableOperandFingerprint(node.right, fingerprints);
    return summarizeRoleValues(
      [node.kind, node.operatorToken.kind, left.a, left.b, right.a, right.b],
      work,
    );
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    const operand = fingerprintValue(node.operand, fingerprints);
    return summarizeRoleValues(
      [node.kind, node.operator, operand.a, operand.b],
      work,
    );
  }
  return undefined;
}

function summarizeNodeRole(
  kind: ts.SyntaxKind,
  subject: ts.Node,
  fingerprints: ReadonlyMap<ts.Node, Fingerprint>,
  work: AnalysisWorkTracker,
): RoleSummary {
  const fingerprint = fingerprintValue(subject, fingerprints);
  return summarizeRoleValues([kind, fingerprint.a, fingerprint.b], work);
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function isComparisonOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.LessThanToken ||
    kind === ts.SyntaxKind.LessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanToken ||
    kind === ts.SyntaxKind.GreaterThanEqualsToken ||
    kind === ts.SyntaxKind.InKeyword ||
    kind === ts.SyntaxKind.InstanceOfKeyword
  );
}

function stableOperandFingerprint(
  node: ts.Expression,
  fingerprints: ReadonlyMap<ts.Node, Fingerprint>,
): Fingerprint {
  return ts.isLiteralExpression(node)
    ? mixFingerprint(INITIAL_FINGERPRINT, node.kind)
    : fingerprintValue(node, fingerprints);
}

function tryBoundaryRole(
  node: ts.TryStatement,
  work: AnalysisWorkTracker,
): RoleSummary {
  return summarizeRoleValues(
    [
      node.kind,
      node.catchClause === undefined ? 0 : 1,
      node.finallyBlock === undefined ? 0 : 1,
    ],
    work,
  );
}

function fingerprintNode(
  node: ts.Node,
  work: AnalysisWorkTracker,
): Fingerprint {
  let fingerprint = mixFingerprint(INITIAL_FINGERPRINT, node.kind);
  if (ts.isBinaryExpression(node)) {
    fingerprint = mixFingerprint(fingerprint, node.operatorToken.kind);
  } else if (
    ts.isPrefixUnaryExpression(node) ||
    ts.isPostfixUnaryExpression(node)
  ) {
    fingerprint = mixFingerprint(fingerprint, node.operator);
  }
  const text = semanticTokenText(node);
  if (text === undefined) return fingerprint;
  work.consume("structuralFingerprintTextUnits", text.length);
  for (let index = 0; index < text.length; index += 1) {
    fingerprint = mixFingerprint(fingerprint, text.charCodeAt(index));
  }
  return fingerprint;
}

function semanticTokenText(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node)
  ) {
    return node.text;
  }
  return undefined;
}

function combineFingerprint(
  parent: Fingerprint,
  child: Fingerprint,
): Fingerprint {
  return mixFingerprint(mixFingerprint(parent, child.a), child.b);
}
