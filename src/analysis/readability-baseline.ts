import type {
  FunctionMetrics,
  SourceAnalysisResult,
  TryBlockMetrics,
} from "./language-analyzer.js";

export interface ReadabilityIdentityDiagnostic {
  readonly code: "DUPLICATE_STRUCTURAL_ID" | "INCOMPLETE_ANALYSIS";
  readonly message: string;
  readonly symbolId?: string;
  readonly source: "baseline" | "current";
  readonly unitKind?: "function" | "try";
}

export class BaselineIdentityIndex {
  readonly diagnostics: readonly ReadabilityIdentityDiagnostic[];
  readonly #baselineFunctions = new Map<string, FunctionMetrics>();
  readonly #baselineTries = new Map<string, TryBlockMetrics>();
  #operations = 0;

  constructor(
    current: SourceAnalysisResult,
    baseline: SourceAnalysisResult | undefined,
  ) {
    const diagnostics: ReadabilityIdentityDiagnostic[] = [];
    this.indexUnits(
      current.functions,
      new Map<string, FunctionMetrics>(),
      "current",
      "function",
      diagnostics,
    );
    this.indexUnits(
      current.tryBlocks,
      new Map<string, TryBlockMetrics>(),
      "current",
      "try",
      diagnostics,
    );
    if (baseline !== undefined) {
      this.indexUnits(
        baseline.functions,
        this.#baselineFunctions,
        "baseline",
        "function",
        diagnostics,
      );
      this.indexUnits(
        baseline.tryBlocks,
        this.#baselineTries,
        "baseline",
        "try",
        diagnostics,
      );
    }
    this.diagnostics = diagnostics;
  }

  get operations(): number {
    return this.#operations;
  }

  functionFor(symbolId: string): FunctionMetrics | undefined {
    this.#operations += 1;
    return this.#baselineFunctions.get(symbolId);
  }

  tryFor(symbolId: string): TryBlockMetrics | undefined {
    this.#operations += 1;
    return this.#baselineTries.get(symbolId);
  }

  private indexUnits<T extends FunctionMetrics | TryBlockMetrics>(
    units: readonly T[],
    index: Map<string, T>,
    source: "baseline" | "current",
    unitKind: "function" | "try",
    diagnostics: ReadabilityIdentityDiagnostic[],
  ): void {
    for (const unit of units) {
      this.#operations += 1;
      if (index.has(unit.symbolId)) {
        diagnostics.push({
          code: "DUPLICATE_STRUCTURAL_ID",
          message: `${source} ${unitKind} identity is duplicated: ${unit.symbolId}`,
          symbolId: unit.symbolId,
          source,
          unitKind,
        });
      } else {
        index.set(unit.symbolId, unit);
      }
    }
  }
}
