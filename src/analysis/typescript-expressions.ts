import ts from "typescript";

import type {
  ConditionalExpressionCategory,
  ExpressionEvidence,
} from "./language-analyzer.js";
import { propertyNameText, sourceRange } from "./typescript-ast.js";

const CATEGORY_BITS: Readonly<Record<ConditionalExpressionCategory, number>> = {
  ternary: 1 << 0,
  optional_chain: 1 << 1,
  logical_and: 1 << 2,
  logical_or: 1 << 3,
  nullish: 1 << 4,
};

export interface NullishChainMetrics {
  readonly values: number;
  readonly semanticSources: number;
  readonly visitedNodes: number;
}

export interface ReturnedObjectAlternatives {
  readonly objects: readonly ts.ObjectLiteralExpression[];
  readonly visitedNodes: number;
}

export interface StateVariant {
  readonly key: string;
  readonly value: string;
}

export function isControlNode(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isConditionalExpression(node)
  );
}

export function isDecisionNode(node: ts.Node): boolean {
  if (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isConditionalExpression(node) ||
    ts.isCatchClause(node)
  ) {
    return true;
  }
  return (
    ts.isBinaryExpression(node) && isLogicalOperator(node.operatorToken.kind)
  );
}

function isLogicalOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

export function conditionalCategory(
  node: ts.Node,
): ConditionalExpressionCategory | undefined {
  if (ts.isConditionalExpression(node)) return "ternary";
  if (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isCallExpression(node)) &&
    node.questionDotToken !== undefined
  ) {
    return "optional_chain";
  }
  if (!ts.isBinaryExpression(node)) return undefined;
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return "logical_and";
    case ts.SyntaxKind.BarBarToken:
      return "logical_or";
    case ts.SyntaxKind.QuestionQuestionToken:
      return "nullish";
    default:
      return undefined;
  }
}

export function ownCategoryMask(node: ts.Node): number {
  const category = conditionalCategory(node);
  return category === undefined ? 0 : CATEGORY_BITS[category];
}

function categoriesFromMask(
  mask: number,
): readonly ConditionalExpressionCategory[] {
  return (Object.keys(CATEGORY_BITS) as ConditionalExpressionCategory[]).filter(
    (category) => (mask & CATEGORY_BITS[category]) !== 0,
  );
}

export function mixedExpressionEvidence(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  categoryMask: number,
): ExpressionEvidence | undefined {
  if (conditionalCategory(node) === undefined) return undefined;
  const categories = categoriesFromMask(categoryMask);
  if (categories.length < 2) return undefined;
  if (conditionalCategory(node.parent) !== undefined) return undefined;
  return {
    range: sourceRange(sourceFile, node),
    categories,
  };
}

export function isRootNullish(node: ts.BinaryExpression): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken)
    return false;
  const parent = node.parent;
  return !(
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

export function nullishChainMetrics(
  root: ts.BinaryExpression,
): NullishChainMetrics {
  const stack: ts.Expression[] = [root];
  const values: ts.Expression[] = [];
  let visitedNodes = 0;
  while (stack.length > 0) {
    const expression = stack.pop();
    if (expression === undefined) continue;
    visitedNodes += 1;
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      stack.push(expression.right, expression.left);
    } else {
      values.push(expression);
    }
  }
  const semanticSources = new Set(
    values
      .map((value) => {
        const source = semanticRoot(value);
        visitedNodes += source.visitedNodes;
        return source.key;
      })
      .filter((value): value is string => value !== undefined),
  );
  return {
    values: values.length,
    semanticSources: semanticSources.size,
    visitedNodes,
  };
}

function semanticRoot(expression: ts.Expression): {
  readonly key?: string;
  readonly visitedNodes: number;
} {
  let current = expression;
  const suffixes: string[] = [];
  let visitedNodes = 0;
  for (;;) {
    visitedNodes += 1;
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    } else if (ts.isPropertyAccessExpression(current)) {
      suffixes.push(`.${current.name.text}`);
      current = current.expression;
    } else if (ts.isElementAccessExpression(current)) {
      if (ts.isStringLiteralLike(current.argumentExpression)) {
        suffixes.push(`[${current.argumentExpression.text}]`);
      }
      current = current.expression;
    } else if (ts.isCallExpression(current)) {
      suffixes.push("()");
      current = current.expression;
    } else if (ts.isIdentifier(current)) {
      return {
        key: `${current.text}${suffixes.reverse().join("")}`,
        visitedNodes,
      };
    } else {
      return { visitedNodes };
    }
  }
}

export function objectShape(
  node: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
): string {
  return node.properties
    .map((property) => objectPropertyName(property, sourceFile))
    .sort()
    .join("|");
}

function objectPropertyName(
  property: ts.ObjectLiteralElementLike,
  sourceFile: ts.SourceFile,
): string {
  if (ts.isSpreadAssignment(property)) return "...spread";
  const name = propertyNameText(property.name, sourceFile);
  if (
    ts.isPropertyAssignment(property) &&
    ["code", "kind", "ok", "state", "status", "type"].includes(name) &&
    (ts.isStringLiteralLike(property.initializer) ||
      ts.isNumericLiteral(property.initializer))
  ) {
    return `${name}=${property.initializer.text}`;
  }
  return name;
}

export function returnedObjectAlternatives(
  root: ts.Expression,
): ReturnedObjectAlternatives {
  const stack: ts.Expression[] = [root];
  const objects: ts.ObjectLiteralExpression[] = [];
  let visitedNodes = 0;
  while (stack.length > 0) {
    const expression = stack.pop();
    if (expression === undefined) continue;
    visitedNodes += 1;
    const unwrapped = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(unwrapped)) {
      objects.push(unwrapped);
    } else if (ts.isConditionalExpression(unwrapped)) {
      stack.push(unwrapped.whenFalse, unwrapped.whenTrue);
    } else if (
      ts.isBinaryExpression(unwrapped) &&
      isLogicalOperator(unwrapped.operatorToken.kind)
    ) {
      stack.push(unwrapped.right, unwrapped.left);
    }
  }
  return { objects, visitedNodes };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function isBroadErrorStringClassification(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) return false;
  const broadMethods = [
    "endsWith",
    "includes",
    "match",
    "search",
    "startsWith",
    "test",
  ];
  if (!broadMethods.includes(expression.name.text)) return false;
  const text = `${expression.expression.getText()} ${node.arguments
    .map((argument) => argument.getText())
    .join(" ")}`;
  return /(?:message|error|reason)/iu.test(text);
}

export function equalityVariant(node: ts.Node): StateVariant | undefined {
  if (
    !ts.isBinaryExpression(node) ||
    !isEqualityOperator(node.operatorToken.kind)
  ) {
    return undefined;
  }
  const leftKey = stateKey(node.left);
  const rightKey = stateKey(node.right);
  const leftValue = literalValue(node.left);
  const rightValue = literalValue(node.right);
  if (leftKey !== undefined && rightValue !== undefined) {
    return { key: leftKey, value: rightValue };
  }
  if (rightKey !== undefined && leftValue !== undefined) {
    return { key: rightKey, value: leftValue };
  }
  return undefined;
}

export function switchVariants(node: ts.Node): readonly StateVariant[] {
  if (!ts.isSwitchStatement(node)) return [];
  const key = stateKey(node.expression);
  if (key === undefined) return [];
  return node.caseBlock.clauses.flatMap((clause) => {
    if (!ts.isCaseClause(clause)) return [];
    const value = literalValue(clause.expression);
    return value === undefined ? [] : [{ key, value }];
  });
}

function isEqualityOperator(kind: ts.SyntaxKind): boolean {
  return [
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ].includes(kind);
}

function stateKey(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.getText();
  return undefined;
}

function literalValue(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
  return undefined;
}
