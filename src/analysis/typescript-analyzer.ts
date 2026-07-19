import { extname } from "node:path";

import ts from "typescript";

import type {
  AnalysisLimits,
  LanguageAnalyzer,
  SourceAnalysisInput,
  SourceAnalysisResult,
} from "./language-analyzer.js";
import {
  collectAst,
  effectiveAnalysisLimits,
  emptyAnalysisResult,
  invalidAnalysisLimit,
  isFunctionUnit,
  parseSourceFile,
  parserDiagnostics,
  sourceLanguage,
} from "./typescript-ast.js";
import { createStructuralIdentityIndex } from "./typescript-identities.js";
import {
  AnalysisWorkLimitError,
  AnalysisWorkTracker,
  createFileMetrics,
  createFunctionMetrics,
  createTryMetrics,
} from "./typescript-metrics.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

export function analyzeTypeScriptSource(
  path: string,
  source: string,
  limits?: AnalysisLimits,
): SourceAnalysisResult {
  const invalidLimit = invalidAnalysisLimit(limits);
  if (invalidLimit !== undefined) {
    return emptyAnalysisResult(path, source, {
      code: "INVALID_ANALYSIS_LIMIT",
      category: "incomplete",
      path,
      message: `${invalidLimit.name} must be a finite nonnegative integer`,
    });
  }
  const bounded = effectiveAnalysisLimits(limits);
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > bounded.maxBytes) {
    return emptyAnalysisResult(path, source, {
      code: "SOURCE_TOO_LARGE",
      category: "incomplete",
      path,
      message: `Source uses ${String(bytes)} bytes, exceeding the ${String(bounded.maxBytes)}-byte analysis limit`,
    });
  }

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = parseSourceFile(path, source);
  } catch (error) {
    return emptyAnalysisResult(path, source, {
      code: "PARSER_FAILED",
      category: "incomplete",
      path,
      message:
        error instanceof Error ? error.message : "TypeScript parser failed",
    });
  }

  const collected = collectAst(sourceFile, bounded.maxNodes);
  if (collected.exceeded) {
    return {
      ...emptyAnalysisResult(path, source, {
        code: "AST_NODE_LIMIT_EXCEEDED",
        category: "incomplete",
        path,
        message: `AST traversal exceeded the ${String(bounded.maxNodes)}-node analysis limit`,
      }),
      visitedNodes: collected.visitedNodes,
      analysisWork: {
        astNodeVisits: collected.visitedNodes,
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
        totalNodeVisits: collected.visitedNodes,
      },
    };
  }

  const diagnostics = parserDiagnostics(path, sourceFile);
  const work = new AnalysisWorkTracker(collected.visitedNodes, bounded.maxWork);
  try {
    const identities = createStructuralIdentityIndex(
      collected.nodes,
      sourceFile,
      work,
    );
    if (identities.duplicateIds.length > 0) {
      return {
        ...emptyAnalysisResult(path, source, {
          code: "DUPLICATE_STRUCTURAL_ID",
          category: "incomplete",
          path,
          message: `Structural identity is not unique: ${identities.duplicateIds[0] ?? "unknown"}`,
        }),
        visitedNodes: collected.visitedNodes,
        analysisWork: work.snapshot(),
      };
    }
    const functions = collected.nodes
      .filter(isFunctionUnit)
      .map((node) => createFunctionMetrics(node, sourceFile, work, identities))
      .sort(
        (left, right) => left.range.start.offset - right.range.start.offset,
      );
    const tryBlocks = collected.nodes
      .filter(ts.isTryStatement)
      .map((node) => createTryMetrics(node, sourceFile, work, identities))
      .sort(
        (left, right) => left.range.start.offset - right.range.start.offset,
      );
    const file = createFileMetrics(sourceFile, source, work);

    return {
      language: sourceLanguage(path),
      path,
      complete: diagnostics.length === 0,
      visitedNodes: collected.visitedNodes,
      diagnostics,
      analysisWork: work.snapshot(),
      file,
      functions,
      tryBlocks,
    };
  } catch (error) {
    if (!(error instanceof AnalysisWorkLimitError)) throw error;
    return {
      ...emptyAnalysisResult(path, source, {
        code: "ANALYSIS_WORK_LIMIT_EXCEEDED",
        category: "incomplete",
        path,
        message: error.message,
      }),
      visitedNodes: collected.visitedNodes,
      analysisWork: work.snapshot(),
    };
  }
}

export function createTypeScriptAnalyzer(): LanguageAnalyzer {
  return {
    supports(path: string): boolean {
      return SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase());
    },
    analyze(input: SourceAnalysisInput): SourceAnalysisResult {
      return analyzeTypeScriptSource(input.path, input.source, input.limits);
    },
  };
}
