import type {
  CodeMetrics,
  FunctionMetrics,
  SourceAnalysisResult,
  SourceRange,
  TryBlockMetrics,
} from "./language-analyzer.js";
import {
  BaselineIdentityIndex,
  type ReadabilityIdentityDiagnostic,
} from "./readability-baseline.js";

export const READABILITY_RULE_IDS = [
  "CQ-READ-001",
  "CQ-READ-002",
  "CQ-READ-003",
  "CQ-READ-004",
  "CQ-READ-005",
  "CQ-READ-006",
  "CQ-READ-007",
  "CQ-READ-008",
] as const;

export type ReadabilityRuleId = (typeof READABILITY_RULE_IDS)[number];
export type ReadabilityGate = "PASS" | "WARN" | "BLOCK" | "INCOMPLETE";
export type ReadabilitySeverity = "P1" | "P2" | "P3";
export type HotspotClassification =
  "new" | "expanded" | "improved" | "unchanged";
export type GateImpact = "none" | "warn" | "block";

export interface ReadabilityEvidence {
  readonly metric: string;
  readonly value: number;
  readonly threshold?: number;
  readonly baseline?: number;
  readonly delta?: number;
}

export interface ReadabilityCandidate {
  readonly ruleId: ReadabilityRuleId;
  readonly severity: ReadabilitySeverity;
  readonly classification: HotspotClassification;
  readonly symbol?: string;
  readonly symbolId?: string;
  readonly range: SourceRange;
  readonly message: string;
  readonly evidence: readonly ReadabilityEvidence[];
  readonly assessmentRequired: boolean;
  readonly hardGate: boolean;
  readonly requiresWaiver: boolean;
  readonly gateImpact: GateImpact;
}

export interface ReadabilityReport {
  readonly path: string;
  readonly gate: ReadabilityGate;
  readonly candidates: readonly ReadabilityCandidate[];
  readonly diagnostics: readonly ReadabilityIdentityDiagnostic[];
  readonly baselineMatchOperations: number;
}

interface CandidateOptions {
  readonly symbol?: string;
  readonly symbolId?: string;
  readonly assessmentRequired?: boolean;
  readonly hardGate?: boolean;
  readonly gateImpact?: GateImpact;
}

function scalarClassification(
  current: number,
  baseline: number | undefined,
): HotspotClassification {
  if (baseline === undefined) return "new";
  if (current > baseline) return "expanded";
  if (current < baseline) return "improved";
  return "unchanged";
}

function metricClassification(
  current: readonly number[],
  baseline: readonly number[] | undefined,
): HotspotClassification {
  if (baseline === undefined) return "new";
  let increased = false;
  let decreased = false;
  for (let index = 0; index < current.length; index += 1) {
    const currentValue = current[index] ?? 0;
    const baselineValue = baseline[index] ?? 0;
    if (currentValue > baselineValue) increased = true;
    if (currentValue < baselineValue) decreased = true;
  }
  if (increased) return "expanded";
  if (decreased) return "improved";
  return "unchanged";
}

function evidence(
  metric: string,
  value: number,
  threshold?: number,
  baseline?: number,
): ReadabilityEvidence {
  return {
    metric,
    value,
    ...(threshold === undefined ? {} : { threshold }),
    ...(baseline === undefined ? {} : { baseline, delta: value - baseline }),
  };
}

function candidate(
  ruleId: ReadabilityRuleId,
  severity: ReadabilitySeverity,
  classification: HotspotClassification,
  range: SourceRange,
  message: string,
  candidateEvidence: readonly ReadabilityEvidence[],
  options: CandidateOptions = {},
): ReadabilityCandidate {
  const hardGate = options.hardGate ?? false;
  return {
    ruleId,
    severity,
    classification,
    ...(options.symbol === undefined ? {} : { symbol: options.symbol }),
    ...(options.symbolId === undefined ? {} : { symbolId: options.symbolId }),
    range,
    message,
    evidence: candidateEvidence,
    assessmentRequired: options.assessmentRequired ?? true,
    hardGate,
    requiresWaiver: hardGate,
    gateImpact: options.gateImpact ?? "warn",
  };
}

function isNewOrExpanded(value: HotspotClassification): boolean {
  return value === "new" || value === "expanded";
}

function functionSizeCandidate(
  unit: FunctionMetrics,
  baseline: FunctionMetrics | undefined,
): ReadabilityCandidate | undefined {
  const lines = unit.range.lineSpan;
  if (lines <= 80) return undefined;
  const baselineLines = baseline?.range.lineSpan;
  const classification = scalarClassification(lines, baselineLines);
  const hardGate = classification === "new" && lines > 300;
  const blockingThreshold = lines > 150 && isNewOrExpanded(classification);
  return candidate(
    "CQ-READ-001",
    hardGate ? "P1" : blockingThreshold ? "P2" : "P3",
    classification,
    unit.range,
    `Function ${unit.name} spans ${String(lines)} lines and requires a single-responsibility assessment`,
    [
      evidence("line_span", lines, 80, baselineLines),
      evidence(
        "decision_count",
        unit.decisionCount,
        undefined,
        baseline?.decisionCount,
      ),
      evidence(
        "max_control_nesting",
        unit.maxControlNesting,
        undefined,
        baseline?.maxControlNesting,
      ),
    ],
    {
      symbol: unit.name,
      symbolId: unit.symbolId,
      hardGate,
      gateImpact: hardGate || blockingThreshold ? "block" : "warn",
    },
  );
}

function fileSizeCandidate(
  current: SourceAnalysisResult,
  baseline: SourceAnalysisResult | undefined,
): ReadabilityCandidate | undefined {
  const lines = current.file.range.lineSpan;
  if (lines <= 600) return undefined;
  const baselineLines = baseline?.file.range.lineSpan;
  const classification = scalarClassification(lines, baselineLines);
  if (classification !== "new") return undefined;
  const hardGate = lines > 1000;
  return candidate(
    "CQ-READ-002",
    hardGate ? "P1" : "P3",
    classification,
    current.file.range,
    `New file spans ${String(lines)} lines and requires an ownership assessment`,
    [evidence("line_span", lines, 600, baselineLines)],
    { hardGate, gateImpact: hardGate ? "block" : "warn" },
  );
}

function trySizeCandidate(
  unit: TryBlockMetrics,
  baseline: TryBlockMetrics | undefined,
): ReadabilityCandidate | undefined {
  const lines = unit.range.lineSpan;
  if (lines <= 80) return undefined;
  const baselineLines = baseline?.range.lineSpan;
  const classification = scalarClassification(lines, baselineLines);
  const blockingThreshold = lines > 150 && isNewOrExpanded(classification);
  return candidate(
    "CQ-READ-003",
    blockingThreshold ? "P2" : "P3",
    classification,
    unit.range,
    `Try block spans ${String(lines)} lines and requires an error-boundary assessment`,
    [
      evidence("line_span", lines, 80, baselineLines),
      evidence("await_count", unit.awaitCount, undefined, baseline?.awaitCount),
      evidence(
        "return_count",
        unit.returnCount,
        undefined,
        baseline?.returnCount,
      ),
    ],
    {
      ...(unit.ownerName === undefined ? {} : { symbol: unit.ownerName }),
      symbolId: unit.symbolId,
      gateImpact: blockingThreshold ? "block" : "warn",
    },
  );
}

function fallbackCandidate(
  unit: FunctionMetrics,
  baseline: FunctionMetrics | undefined,
): ReadabilityCandidate | undefined {
  const mixedCount = unit.mixedConditionalFallbackExpressions.length;
  const baselineMixedCount =
    baseline?.mixedConditionalFallbackExpressions.length;
  const qualifiesNullish =
    unit.maximumNullishChainValues >= 3 &&
    (unit.maximumNullishChainSemanticSources >= 2 || mixedCount > 0);
  if (unit.nestedTernaryDepth < 2 && !qualifiesNullish && mixedCount === 0) {
    return undefined;
  }
  const currentMetrics = [
    unit.nestedTernaryDepth,
    unit.maximumNullishChainValues,
    unit.maximumNullishChainSemanticSources,
    mixedCount,
  ];
  const baselineMetrics =
    baseline === undefined
      ? undefined
      : [
          baseline.nestedTernaryDepth,
          baseline.maximumNullishChainValues,
          baseline.maximumNullishChainSemanticSources,
          baselineMixedCount ?? 0,
        ];
  return candidate(
    "CQ-READ-004",
    "P3",
    metricClassification(currentMetrics, baselineMetrics),
    unit.range,
    `Function ${unit.name} combines conditional and fallback priorities that require semantic review`,
    [
      evidence(
        "nested_ternary_depth",
        unit.nestedTernaryDepth,
        2,
        baseline?.nestedTernaryDepth,
      ),
      evidence(
        "maximum_nullish_chain_values",
        unit.maximumNullishChainValues,
        3,
        baseline?.maximumNullishChainValues,
      ),
      evidence(
        "maximum_nullish_chain_semantic_sources",
        unit.maximumNullishChainSemanticSources,
        2,
        baseline?.maximumNullishChainSemanticSources,
      ),
      evidence("mixed_expression_count", mixedCount, 1, baselineMixedCount),
    ],
    { symbol: unit.name, symbolId: unit.symbolId },
  );
}

function stateCandidate(
  unit: FunctionMetrics,
  baseline: FunctionMetrics | undefined,
): ReadabilityCandidate | undefined {
  if (unit.implicitStateBranchCount === 0) return undefined;
  return candidate(
    "CQ-READ-005",
    "P3",
    metricClassification(
      [unit.implicitStateBranchCount],
      baseline === undefined ? undefined : [baseline.implicitStateBranchCount],
    ),
    unit.range,
    `Function ${unit.name} compares one or more state values across at least three variants`,
    [
      evidence(
        "implicit_state_branch_count",
        unit.implicitStateBranchCount,
        1,
        baseline?.implicitStateBranchCount,
      ),
    ],
    { symbol: unit.name, symbolId: unit.symbolId },
  );
}

function resultShapeCandidate(
  unit: FunctionMetrics,
  baseline: FunctionMetrics | undefined,
): ReadabilityCandidate | undefined {
  const largeObjects = unit.largeObjectLiterals.length;
  const shapes = unit.distinctReturnObjectShapes.length;
  if (largeObjects === 0 && shapes < 2) return undefined;
  return candidate(
    "CQ-READ-006",
    "P3",
    metricClassification(
      [largeObjects, shapes],
      baseline === undefined
        ? undefined
        : [
            baseline.largeObjectLiterals.length,
            baseline.distinctReturnObjectShapes.length,
          ],
    ),
    unit.range,
    `Function ${unit.name} contains large inline objects or multiple return-object shapes`,
    [
      evidence(
        "large_object_literal_count",
        largeObjects,
        1,
        baseline?.largeObjectLiterals.length,
      ),
      evidence(
        "distinct_return_object_shapes",
        shapes,
        2,
        baseline?.distinctReturnObjectShapes.length,
      ),
    ],
    { symbol: unit.name, symbolId: unit.symbolId },
  );
}

function errorStringCandidate(
  unit: FunctionMetrics,
  baseline: FunctionMetrics | undefined,
): ReadabilityCandidate | undefined {
  const count = unit.broadErrorStringClassificationCount;
  if (count === 0) return undefined;
  return candidate(
    "CQ-READ-007",
    "P3",
    metricClassification(
      [count],
      baseline === undefined
        ? undefined
        : [baseline.broadErrorStringClassificationCount],
    ),
    unit.range,
    `Function ${unit.name} classifies errors using broad string content`,
    [
      evidence(
        "broad_error_string_classification_count",
        count,
        1,
        baseline?.broadErrorStringClassificationCount,
      ),
    ],
    { symbol: unit.name, symbolId: unit.symbolId },
  );
}

function cognitiveDistanceCandidate(
  unit: FunctionMetrics,
  baseline: FunctionMetrics | undefined,
): ReadabilityCandidate | undefined {
  const distance = unit.maximumDecisionOutcomeDistanceLines;
  if (
    distance <= 80 ||
    unit.decisionCount === 0 ||
    unit.awaitCount === 0 ||
    unit.returnCount === 0
  ) {
    return undefined;
  }
  return candidate(
    "CQ-READ-008",
    "P3",
    metricClassification(
      [distance, unit.decisionCount, unit.awaitCount, unit.returnCount],
      baseline === undefined
        ? undefined
        : [
            baseline.maximumDecisionOutcomeDistanceLines,
            baseline.decisionCount,
            baseline.awaitCount,
            baseline.returnCount,
          ],
    ),
    unit.range,
    `Function ${unit.name} separates decisions from awaited effects or outcomes by more than 80 lines`,
    [
      evidence(
        "maximum_decision_outcome_distance_lines",
        distance,
        80,
        baseline?.maximumDecisionOutcomeDistanceLines,
      ),
      evidence("decision_count", unit.decisionCount),
      evidence("await_count", unit.awaitCount),
      evidence("return_count", unit.returnCount),
    ],
    { symbol: unit.name, symbolId: unit.symbolId },
  );
}

function semanticSignalCandidates(
  unit: FunctionMetrics,
  baseline: FunctionMetrics | undefined,
): readonly ReadabilityCandidate[] {
  return [
    fallbackCandidate(unit, baseline),
    stateCandidate(unit, baseline),
    resultShapeCandidate(unit, baseline),
    errorStringCandidate(unit, baseline),
    cognitiveDistanceCandidate(unit, baseline),
  ].filter((value): value is ReadabilityCandidate => value !== undefined);
}

function gateFor(candidates: readonly ReadabilityCandidate[]): ReadabilityGate {
  if (candidates.some(({ gateImpact }) => gateImpact === "block"))
    return "BLOCK";
  return candidates.length > 0 ? "WARN" : "PASS";
}

function compareCandidates(
  left: ReadabilityCandidate,
  right: ReadabilityCandidate,
): number {
  const position = left.range.start.offset - right.range.start.offset;
  return position === 0 ? left.ruleId.localeCompare(right.ruleId) : position;
}

export function evaluateReadability(
  current: SourceAnalysisResult,
  baseline?: SourceAnalysisResult,
): ReadabilityReport {
  if (!current.complete) {
    return {
      path: current.path,
      gate: "INCOMPLETE",
      candidates: [],
      diagnostics: [
        {
          code: "INCOMPLETE_ANALYSIS",
          message: "Current source analysis is incomplete",
          source: "current",
        },
      ],
      baselineMatchOperations: 0,
    };
  }
  if (baseline !== undefined && !baseline.complete) {
    return {
      path: current.path,
      gate: "INCOMPLETE",
      candidates: [],
      diagnostics: [
        {
          code: "INCOMPLETE_ANALYSIS",
          message: "Baseline source analysis is incomplete",
          source: "baseline",
        },
      ],
      baselineMatchOperations: 0,
    };
  }

  const identities = new BaselineIdentityIndex(current, baseline);
  if (identities.diagnostics.length > 0) {
    return {
      path: current.path,
      gate: "INCOMPLETE",
      candidates: [],
      diagnostics: identities.diagnostics,
      baselineMatchOperations: identities.operations,
    };
  }
  const candidates: ReadabilityCandidate[] = [];
  const fileCandidate = fileSizeCandidate(current, baseline);
  if (fileCandidate !== undefined) candidates.push(fileCandidate);

  for (const unit of current.functions) {
    const previous =
      baseline === undefined
        ? undefined
        : identities.functionFor(unit.symbolId);
    const sizeCandidate = functionSizeCandidate(unit, previous);
    if (sizeCandidate !== undefined) candidates.push(sizeCandidate);
    candidates.push(...semanticSignalCandidates(unit, previous));
  }
  for (const unit of current.tryBlocks) {
    const previous =
      baseline === undefined ? undefined : identities.tryFor(unit.symbolId);
    const sizeCandidate = trySizeCandidate(unit, previous);
    if (sizeCandidate !== undefined) candidates.push(sizeCandidate);
  }

  candidates.sort(compareCandidates);
  return {
    path: current.path,
    gate: gateFor(candidates),
    candidates,
    diagnostics: [],
    baselineMatchOperations: identities.operations,
  };
}

export function metricSnapshot(
  metrics: CodeMetrics,
): Readonly<Record<string, number>> {
  return {
    decisionCount: metrics.decisionCount,
    maxControlNesting: metrics.maxControlNesting,
    returnCount: metrics.returnCount,
    awaitCount: metrics.awaitCount,
    localDeclarationCount: metrics.localDeclarationCount,
    catchCount: metrics.catchCount,
    nestedTernaryDepth: metrics.nestedTernaryDepth,
    maximumNullishChainValues: metrics.maximumNullishChainValues,
    maximumNullishChainSemanticSources:
      metrics.maximumNullishChainSemanticSources,
    largeObjectLiteralCount: metrics.largeObjectLiterals.length,
    distinctReturnObjectShapeCount: metrics.distinctReturnObjectShapes.length,
    broadErrorStringClassificationCount:
      metrics.broadErrorStringClassificationCount,
    implicitStateBranchCount: metrics.implicitStateBranchCount,
    maximumDecisionOutcomeDistanceLines:
      metrics.maximumDecisionOutcomeDistanceLines,
  };
}
