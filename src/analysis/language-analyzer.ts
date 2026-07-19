export const DEFAULT_ANALYSIS_LIMITS = {
  maxBytes: 4 * 1024 * 1024,
  maxNodes: 250_000,
  maxWork: 3_000_000,
} as const;

export interface AnalysisLimits {
  readonly maxBytes?: number;
  readonly maxNodes?: number;
  readonly maxWork?: number;
}

export interface SourceAnalysisInput {
  readonly path: string;
  readonly source: string;
  readonly limits?: AnalysisLimits;
}

export interface SourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
  readonly lineSpan: number;
}

export type AnalysisDiagnosticCategory = "incomplete" | "parser";

export interface AnalysisDiagnostic {
  readonly code: string;
  readonly category: AnalysisDiagnosticCategory;
  readonly path: string;
  readonly message: string;
  readonly range?: SourceRange;
}

export type FunctionUnitKind = "function" | "method" | "arrow";

export interface ExpressionEvidence {
  readonly range: SourceRange;
  readonly categories: readonly ConditionalExpressionCategory[];
}

export type ConditionalExpressionCategory =
  "ternary" | "optional_chain" | "logical_and" | "logical_or" | "nullish";

export interface ObjectLiteralEvidence {
  readonly range: SourceRange;
  readonly propertyCount: number;
  readonly shape: string;
}

export interface CodeMetrics {
  readonly decisionCount: number;
  readonly maxControlNesting: number;
  readonly returnCount: number;
  readonly awaitCount: number;
  readonly localDeclarationCount: number;
  readonly catchCount: number;
  readonly nestedTernaryDepth: number;
  readonly maximumNullishChainValues: number;
  readonly maximumNullishChainSemanticSources: number;
  readonly mixedConditionalFallbackExpressions: readonly ExpressionEvidence[];
  readonly largeObjectLiterals: readonly ObjectLiteralEvidence[];
  readonly distinctReturnObjectShapes: readonly string[];
  readonly broadErrorStringClassificationCount: number;
  readonly implicitStateBranchCount: number;
  readonly maximumDecisionOutcomeDistanceLines: number;
}

export interface FunctionMetrics extends CodeMetrics {
  readonly kind: FunctionUnitKind;
  readonly name: string;
  readonly symbolId: string;
  readonly range: SourceRange;
}

export interface TryBlockMetrics extends CodeMetrics {
  readonly ownerName?: string;
  readonly ownerSymbolId?: string;
  readonly symbolId: string;
  readonly range: SourceRange;
}

export interface FileMetrics extends CodeMetrics {
  readonly range: SourceRange;
}

export interface SourceAnalysisResult {
  readonly language: string;
  readonly path: string;
  readonly complete: boolean;
  readonly visitedNodes: number;
  readonly diagnostics: readonly AnalysisDiagnostic[];
  readonly analysisWork: AnalysisWork;
  readonly file: FileMetrics;
  readonly functions: readonly FunctionMetrics[];
  readonly tryBlocks: readonly TryBlockMetrics[];
}

export interface AnalysisWork {
  readonly astNodeVisits: number;
  readonly structuralIdentityNodeVisits: number;
  readonly structuralIdentityEdgeVisits: number;
  readonly structuralFingerprintNodeVisits: number;
  readonly structuralFingerprintTextUnits: number;
  readonly structuralRoleOperations: number;
  readonly structuralPathOperations: number;
  readonly structuralPathTextUnits: number;
  readonly metricNodeVisits: number;
  readonly expressionSummaryNodeVisits: number;
  readonly returnBranchNodeVisits: number;
  readonly nullishChainNodeVisits: number;
  readonly totalNodeVisits: number;
}

export interface LanguageAnalyzer {
  supports(path: string): boolean;
  analyze(input: SourceAnalysisInput): SourceAnalysisResult;
}
