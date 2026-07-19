import ts from "typescript";

import type {
  AnalysisWork,
  CodeMetrics,
  ExpressionEvidence,
  FileMetrics,
  FunctionMetrics,
  ObjectLiteralEvidence,
  TryBlockMetrics,
} from "./language-analyzer.js";
import {
  childNodes,
  fileRange,
  functionKind,
  inferredFunctionName,
  isFunctionUnit,
  sourceRange,
} from "./typescript-ast.js";
import type { StructuralIdentityIndex } from "./typescript-identities.js";
import {
  equalityVariant,
  isBroadErrorStringClassification,
  isControlNode,
  isDecisionNode,
  isRootNullish,
  mixedExpressionEvidence,
  nullishChainMetrics,
  objectShape,
  ownCategoryMask,
  returnedObjectAlternatives,
  switchVariants,
} from "./typescript-expressions.js";

const LARGE_OBJECT_PROPERTY_COUNT = 8;

type WorkCategory =
  | "structuralIdentityNodeVisits"
  | "structuralIdentityEdgeVisits"
  | "structuralFingerprintNodeVisits"
  | "structuralFingerprintTextUnits"
  | "structuralRoleOperations"
  | "structuralPathOperations"
  | "structuralPathTextUnits"
  | "metricNodeVisits"
  | "expressionSummaryNodeVisits"
  | "returnBranchNodeVisits"
  | "nullishChainNodeVisits";

interface TraversalEntry {
  readonly node: ts.Node;
  readonly controlDepth: number;
}

interface ExpressionSummary {
  readonly categoryMask: number;
  readonly nestedTernaryDepth: number;
}

interface MetricAccumulator {
  decisionCount: number;
  maxControlNesting: number;
  returnCount: number;
  awaitCount: number;
  localDeclarationCount: number;
  catchCount: number;
  nestedTernaryDepth: number;
  maximumNullishChainValues: number;
  maximumNullishChainSemanticSources: number;
  broadErrorStringClassificationCount: number;
  readonly mixedExpressions: Map<string, ExpressionEvidence>;
  readonly largeObjects: ObjectLiteralEvidence[];
  readonly returnObjectShapes: Set<string>;
  readonly decisionLines: number[];
  readonly outcomeLines: number[];
  readonly stateVariants: Map<string, Set<string>>;
}

export class AnalysisWorkLimitError extends Error {}

export class AnalysisWorkTracker {
  readonly #limit: number;
  readonly #work = {
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
  };

  constructor(
    readonly astNodeVisits: number,
    maximumWork: number,
  ) {
    this.#limit = maximumWork;
  }

  consume(category: WorkCategory, count = 1): void {
    this.#work[category] += count;
    if (this.snapshot().totalNodeVisits > this.#limit) {
      throw new AnalysisWorkLimitError(
        `Analysis exceeded the ${String(this.#limit)}-node total work budget`,
      );
    }
  }

  snapshot(): AnalysisWork {
    const totalNodeVisits =
      this.astNodeVisits +
      this.#work.structuralIdentityNodeVisits +
      this.#work.structuralIdentityEdgeVisits +
      this.#work.structuralFingerprintNodeVisits +
      this.#work.structuralFingerprintTextUnits +
      this.#work.structuralRoleOperations +
      this.#work.structuralPathOperations +
      this.#work.structuralPathTextUnits +
      this.#work.metricNodeVisits +
      this.#work.expressionSummaryNodeVisits +
      this.#work.returnBranchNodeVisits +
      this.#work.nullishChainNodeVisits;
    return {
      astNodeVisits: this.astNodeVisits,
      ...this.#work,
      totalNodeVisits,
    };
  }
}

function createAccumulator(): MetricAccumulator {
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
    broadErrorStringClassificationCount: 0,
    mixedExpressions: new Map(),
    largeObjects: [],
    returnObjectShapes: new Set(),
    decisionLines: [],
    outcomeLines: [],
    stateVariants: new Map(),
  };
}

function collectMetricEntries(
  root: ts.Node,
  skipNestedFunctions: boolean,
  work: AnalysisWorkTracker,
): readonly TraversalEntry[] {
  const entries: TraversalEntry[] = [];
  const stack: TraversalEntry[] = [{ node: root, controlDepth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) continue;
    if (
      entry.node !== root &&
      skipNestedFunctions &&
      isFunctionUnit(entry.node)
    ) {
      continue;
    }
    work.consume("metricNodeVisits");
    entries.push(entry);
    const childDepth = entry.controlDepth + (isControlNode(entry.node) ? 1 : 0);
    for (const child of childNodes(entry.node)) {
      stack.push({ node: child, controlDepth: childDepth });
    }
  }
  return entries;
}

function buildExpressionSummaries(
  entries: readonly TraversalEntry[],
  work: AnalysisWorkTracker,
): ReadonlyMap<ts.Node, ExpressionSummary> {
  const summaries = new Map<ts.Node, ExpressionSummary>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const node = entries[index]?.node;
    if (node === undefined) continue;
    work.consume("expressionSummaryNodeVisits");
    let categoryMask = ownCategoryMask(node);
    let childTernaryDepth = 0;
    for (const child of childNodes(node)) {
      const childSummary = summaries.get(child);
      if (childSummary === undefined) continue;
      categoryMask |= childSummary.categoryMask;
      childTernaryDepth = Math.max(
        childTernaryDepth,
        childSummary.nestedTernaryDepth,
      );
    }
    summaries.set(node, {
      categoryMask,
      nestedTernaryDepth: ts.isConditionalExpression(node)
        ? childTernaryDepth + 1
        : childTernaryDepth,
    });
  }
  return summaries;
}

function analyzeNode(
  entry: TraversalEntry,
  sourceFile: ts.SourceFile,
  summaries: ReadonlyMap<ts.Node, ExpressionSummary>,
  accumulator: MetricAccumulator,
  work: AnalysisWorkTracker,
): void {
  const { node, controlDepth } = entry;
  const range = sourceRange(sourceFile, node);
  recordFlowMetrics(node, controlDepth, range.start.line, accumulator, work);
  recordExpressionMetrics(node, sourceFile, summaries, accumulator, work);

  if (
    ts.isObjectLiteralExpression(node) &&
    node.properties.length >= LARGE_OBJECT_PROPERTY_COUNT
  ) {
    accumulator.largeObjects.push({
      range,
      propertyCount: node.properties.length,
      shape: objectShape(node, sourceFile),
    });
  }
  if (isBroadErrorStringClassification(node)) {
    accumulator.broadErrorStringClassificationCount += 1;
  }
  const variant = equalityVariant(node);
  if (variant !== undefined) {
    recordStateVariant(accumulator, variant.key, variant.value);
  }
  for (const switchVariant of switchVariants(node)) {
    recordStateVariant(accumulator, switchVariant.key, switchVariant.value);
  }
}

function recordStateVariant(
  accumulator: MetricAccumulator,
  key: string,
  value: string,
): void {
  const variants = accumulator.stateVariants.get(key) ?? new Set<string>();
  variants.add(value);
  accumulator.stateVariants.set(key, variants);
}

function recordFlowMetrics(
  node: ts.Node,
  controlDepth: number,
  line: number,
  accumulator: MetricAccumulator,
  work: AnalysisWorkTracker,
): void {
  if (isDecisionNode(node)) {
    accumulator.decisionCount += 1;
    accumulator.decisionLines.push(line);
  }
  if (isControlNode(node)) {
    accumulator.maxControlNesting = Math.max(
      accumulator.maxControlNesting,
      controlDepth + 1,
    );
  }
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
    accumulator.returnCount += 1;
    accumulator.outcomeLines.push(line);
    recordReturnedExpression(
      node.body,
      node.getSourceFile(),
      accumulator,
      work,
    );
  } else if (ts.isReturnStatement(node)) {
    accumulator.returnCount += 1;
    accumulator.outcomeLines.push(line);
    if (node.expression !== undefined) {
      recordReturnedExpression(
        node.expression,
        node.getSourceFile(),
        accumulator,
        work,
      );
    }
  } else if (ts.isAwaitExpression(node)) {
    accumulator.awaitCount += 1;
    accumulator.outcomeLines.push(line);
  } else if (
    ts.isVariableDeclaration(node) &&
    !ts.isParameter(node) &&
    !ts.isCatchClause(node.parent)
  ) {
    accumulator.localDeclarationCount += 1;
  } else if (ts.isCatchClause(node)) {
    accumulator.catchCount += 1;
    accumulator.outcomeLines.push(line);
  }
}

function recordReturnedExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  accumulator: MetricAccumulator,
  work: AnalysisWorkTracker,
): void {
  const alternatives = returnedObjectAlternatives(expression);
  work.consume("returnBranchNodeVisits", alternatives.visitedNodes);
  for (const object of alternatives.objects) {
    accumulator.returnObjectShapes.add(objectShape(object, sourceFile));
  }
}

function recordExpressionMetrics(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  summaries: ReadonlyMap<ts.Node, ExpressionSummary>,
  accumulator: MetricAccumulator,
  work: AnalysisWorkTracker,
): void {
  const summary = summaries.get(node);
  if (summary === undefined) return;
  if (ts.isConditionalExpression(node)) {
    accumulator.nestedTernaryDepth = Math.max(
      accumulator.nestedTernaryDepth,
      summary.nestedTernaryDepth,
    );
  }
  if (ts.isBinaryExpression(node) && isRootNullish(node)) {
    const chain = nullishChainMetrics(node);
    work.consume("nullishChainNodeVisits", chain.visitedNodes);
    accumulator.maximumNullishChainValues = Math.max(
      accumulator.maximumNullishChainValues,
      chain.values,
    );
    accumulator.maximumNullishChainSemanticSources = Math.max(
      accumulator.maximumNullishChainSemanticSources,
      chain.semanticSources,
    );
  }
  const mixed = mixedExpressionEvidence(node, sourceFile, summary.categoryMask);
  if (mixed !== undefined) {
    const key = `${String(mixed.range.start.offset)}:${String(mixed.range.end.offset)}`;
    accumulator.mixedExpressions.set(key, mixed);
  }
}

function finalizeMetrics(accumulator: MetricAccumulator): CodeMetrics {
  const implicitStateBranchCount = [
    ...accumulator.stateVariants.values(),
  ].filter((variants) => variants.size >= 3).length;
  return {
    decisionCount: accumulator.decisionCount,
    maxControlNesting: accumulator.maxControlNesting,
    returnCount: accumulator.returnCount,
    awaitCount: accumulator.awaitCount,
    localDeclarationCount: accumulator.localDeclarationCount,
    catchCount: accumulator.catchCount,
    nestedTernaryDepth: accumulator.nestedTernaryDepth,
    maximumNullishChainValues: accumulator.maximumNullishChainValues,
    maximumNullishChainSemanticSources:
      accumulator.maximumNullishChainSemanticSources,
    mixedConditionalFallbackExpressions: [
      ...accumulator.mixedExpressions.values(),
    ].sort((left, right) => left.range.start.offset - right.range.start.offset),
    largeObjectLiterals: accumulator.largeObjects.sort(
      (left, right) => left.range.start.offset - right.range.start.offset,
    ),
    distinctReturnObjectShapes: [...accumulator.returnObjectShapes].sort(),
    broadErrorStringClassificationCount:
      accumulator.broadErrorStringClassificationCount,
    implicitStateBranchCount,
    maximumDecisionOutcomeDistanceLines: maximumLineDistance(
      accumulator.decisionLines,
      accumulator.outcomeLines,
    ),
  };
}

function maximumLineDistance(
  decisions: readonly number[],
  outcomes: readonly number[],
): number {
  if (decisions.length === 0 || outcomes.length === 0) return 0;
  let decisionMinimum = Number.POSITIVE_INFINITY;
  let decisionMaximum = Number.NEGATIVE_INFINITY;
  let outcomeMinimum = Number.POSITIVE_INFINITY;
  let outcomeMaximum = Number.NEGATIVE_INFINITY;
  const length = Math.max(decisions.length, outcomes.length);
  for (let index = 0; index < length; index += 1) {
    const decision = decisions[index];
    if (decision !== undefined) {
      decisionMinimum = Math.min(decisionMinimum, decision);
      decisionMaximum = Math.max(decisionMaximum, decision);
    }
    const outcome = outcomes[index];
    if (outcome !== undefined) {
      outcomeMinimum = Math.min(outcomeMinimum, outcome);
      outcomeMaximum = Math.max(outcomeMaximum, outcome);
    }
  }
  return Math.max(
    Math.abs(decisionMaximum - outcomeMinimum),
    Math.abs(outcomeMaximum - decisionMinimum),
  );
}

function metricsForRoot(
  root: ts.Node,
  sourceFile: ts.SourceFile,
  skipNestedFunctions: boolean,
  work: AnalysisWorkTracker,
): CodeMetrics {
  const entries = collectMetricEntries(root, skipNestedFunctions, work);
  const summaries = buildExpressionSummaries(entries, work);
  const accumulator = createAccumulator();
  for (const entry of entries) {
    analyzeNode(entry, sourceFile, summaries, accumulator, work);
  }
  return finalizeMetrics(accumulator);
}

export function createFunctionMetrics(
  node: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  work: AnalysisWorkTracker,
  identities: StructuralIdentityIndex,
): FunctionMetrics {
  const symbolId = identities.functionIds.get(node);
  if (symbolId === undefined) {
    throw new Error("Function is missing its precomputed structural identity");
  }
  return {
    ...metricsForRoot(node, sourceFile, true, work),
    kind: functionKind(node),
    name: inferredFunctionName(node, sourceFile),
    symbolId,
    range: sourceRange(sourceFile, node),
  };
}

export function createTryMetrics(
  node: ts.TryStatement,
  sourceFile: ts.SourceFile,
  work: AnalysisWorkTracker,
  identities: StructuralIdentityIndex,
): TryBlockMetrics {
  const identity = identities.tryIds.get(node);
  if (identity === undefined) {
    throw new Error("Try block is missing its precomputed structural identity");
  }
  return {
    ...metricsForRoot(node.tryBlock, sourceFile, true, work),
    catchCount: node.catchClause === undefined ? 0 : 1,
    range: sourceRange(sourceFile, node.tryBlock),
    ...identity,
  };
}

export function createFileMetrics(
  sourceFile: ts.SourceFile,
  source: string,
  work: AnalysisWorkTracker,
): FileMetrics {
  return {
    ...metricsForRoot(sourceFile, sourceFile, false, work),
    range: fileRange(sourceFile, source),
  };
}
