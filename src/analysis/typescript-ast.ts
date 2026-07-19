import { extname } from "node:path";

import ts from "typescript";

import {
  DEFAULT_ANALYSIS_LIMITS,
  type AnalysisDiagnostic,
  type AnalysisLimits,
  type CodeMetrics,
  type FunctionUnitKind,
  type SourceAnalysisResult,
  type SourcePosition,
  type SourceRange,
} from "./language-analyzer.js";

export interface EffectiveAnalysisLimits {
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly maxWork: number;
}

export interface InvalidAnalysisLimit {
  readonly name: keyof AnalysisLimits;
  readonly value: number;
}

export interface CollectedAst {
  readonly nodes: readonly ts.Node[];
  readonly visitedNodes: number;
  readonly exceeded: boolean;
}

interface SourceFileWithParseDiagnostics extends ts.SourceFile {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
}

export function effectiveAnalysisLimits(
  limits: AnalysisLimits | undefined,
): EffectiveAnalysisLimits {
  return {
    maxBytes: boundedLimit(limits?.maxBytes, DEFAULT_ANALYSIS_LIMITS.maxBytes),
    maxNodes: boundedLimit(limits?.maxNodes, DEFAULT_ANALYSIS_LIMITS.maxNodes),
    maxWork: boundedLimit(
      limits?.maxWork ??
        Math.min(
          DEFAULT_ANALYSIS_LIMITS.maxWork,
          (limits?.maxNodes ?? DEFAULT_ANALYSIS_LIMITS.maxNodes) * 12,
        ),
      DEFAULT_ANALYSIS_LIMITS.maxWork,
    ),
  };
}

export function invalidAnalysisLimit(
  limits: AnalysisLimits | undefined,
): InvalidAnalysisLimit | undefined {
  if (limits === undefined) return undefined;
  for (const name of ["maxBytes", "maxNodes", "maxWork"] as const) {
    const value = limits[name];
    if (
      value !== undefined &&
      (!Number.isFinite(value) || !Number.isInteger(value) || value < 0)
    ) {
      return { name, value };
    }
  }
  return undefined;
}

function boundedLimit(
  requested: number | undefined,
  hardMaximum: number,
): number {
  return Math.max(0, Math.min(requested ?? hardMaximum, hardMaximum));
}

export function parseSourceFile(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
}

export function sourceLanguage(path: string): "javascript" | "typescript" {
  return [".cjs", ".js", ".jsx", ".mjs"].includes(extname(path).toLowerCase())
    ? "javascript"
    : "typescript";
}

function scriptKind(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".mts":
    case ".cts":
    default:
      return ts.ScriptKind.TS;
  }
}

export function collectAst(
  sourceFile: ts.SourceFile,
  maxNodes: number,
): CollectedAst {
  const stack: ts.Node[] = [sourceFile];
  const nodes: ts.Node[] = [];
  let visitedNodes = 0;

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    visitedNodes += 1;
    if (visitedNodes > maxNodes) {
      return { nodes, visitedNodes, exceeded: true };
    }
    nodes.push(node);
    const children = childNodes(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }

  return { nodes, visitedNodes, exceeded: false };
}

export function parserDiagnostics(
  path: string,
  sourceFile: ts.SourceFile,
): readonly AnalysisDiagnostic[] {
  const parsed = sourceFile as SourceFileWithParseDiagnostics;
  return (parsed.parseDiagnostics ?? []).map((diagnostic) => {
    const base = {
      code: `TS${String(diagnostic.code)}`,
      category: "parser" as const,
      path,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    };
    if (diagnostic.start === undefined || diagnostic.length === undefined) {
      return base;
    }
    return {
      ...base,
      range: rangeFromOffsets(
        sourceFile,
        diagnostic.start,
        diagnostic.start + diagnostic.length,
      ),
    };
  });
}

export function sourceRange(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): SourceRange {
  return rangeFromOffsets(sourceFile, node.getStart(sourceFile), node.getEnd());
}

function rangeFromOffsets(
  sourceFile: ts.SourceFile,
  startOffset: number,
  endOffset: number,
): SourceRange {
  const inclusiveEndOffset = Math.max(startOffset, endOffset - 1);
  const start = sourcePosition(sourceFile, startOffset);
  const inclusiveEnd = sourcePosition(sourceFile, inclusiveEndOffset);
  return {
    start,
    end: sourcePosition(sourceFile, endOffset),
    lineSpan: inclusiveEnd.line - start.line + 1,
  };
}

function sourcePosition(
  sourceFile: ts.SourceFile,
  offset: number,
): SourcePosition {
  const location = sourceFile.getLineAndCharacterOfPosition(offset);
  return {
    offset,
    line: location.line + 1,
    column: location.character + 1,
  };
}

export function fileRange(
  sourceFile: ts.SourceFile,
  source: string,
): SourceRange {
  return {
    start: sourcePosition(sourceFile, 0),
    end: sourcePosition(sourceFile, source.length),
    lineSpan: source.split("\n").length,
  };
}

export function emptyAnalysisResult(
  path: string,
  source: string,
  diagnostic: AnalysisDiagnostic,
): SourceAnalysisResult {
  const emptyPosition = { offset: 0, line: 1, column: 1 };
  const range: SourceRange = {
    start: emptyPosition,
    end: emptyPosition,
    lineSpan: source.split("\n").length,
  };
  return {
    language: sourceLanguage(path),
    path,
    complete: false,
    visitedNodes: 0,
    diagnostics: [diagnostic],
    analysisWork: {
      astNodeVisits: 0,
      structuralIdentityNodeVisits: 0,
      structuralIdentityEdgeVisits: 0,
      structuralFingerprintNodeVisits: 0,
      structuralFingerprintTextUnits: 0,
      structuralRoleOperations: 0,
      structuralPathOperations: 0,
      structuralPathTextUnits: 0,
      metricNodeVisits: 0,
      expressionSummaryNodeVisits: 0,
      returnBranchNodeVisits: 0,
      nullishChainNodeVisits: 0,
      totalNodeVisits: 0,
    },
    file: { ...emptyCodeMetrics(), range },
    functions: [],
    tryBlocks: [],
  };
}

function emptyCodeMetrics(): CodeMetrics {
  return {
    decisionCount: 0,
    maxControlNesting: 0,
    returnCount: 0,
    awaitCount: 0,
    localDeclarationCount: 0,
    catchCount: 0,
    nestedTernaryDepth: 0,
    maximumNullishChainValues: 0,
    maximumNullishChainSemanticSources: 0,
    mixedConditionalFallbackExpressions: [],
    largeObjectLiterals: [],
    distinctReturnObjectShapes: [],
    broadErrorStringClassificationCount: 0,
    implicitStateBranchCount: 0,
    maximumDecisionOutcomeDistanceLines: 0,
  };
}

export function childNodes(node: ts.Node): readonly ts.Node[] {
  const children: ts.Node[] = [];
  node.forEachChild((child) => {
    children.push(child);
  });
  return children;
}

export function isFunctionUnit(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return true;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.body !== undefined;
  }
  return false;
}

export function functionKind(
  node: ts.FunctionLikeDeclaration,
): FunctionUnitKind {
  if (ts.isArrowFunction(node)) return "arrow";
  if (
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return "method";
  }
  return "function";
}

export function propertyNameText(
  name: ts.PropertyName,
  sourceFile: ts.SourceFile,
): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    return name.text;
  return name.getText(sourceFile);
}

export function inferredFunctionName(
  node: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
): string {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (node.name !== undefined) return propertyNameText(node.name, sourceFile);
  if (
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  if (ts.isPropertyAssignment(node.parent)) {
    return propertyNameText(node.parent.name, sourceFile);
  }
  const position = sourceRange(sourceFile, node).start;
  return `<anonymous@${String(position.line)}:${String(position.column)}>`;
}
