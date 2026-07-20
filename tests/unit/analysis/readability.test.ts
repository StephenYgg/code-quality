import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import type {
  FunctionMetrics,
  SourceAnalysisResult,
} from "../../../src/analysis/language-analyzer.js";
import { analyzeTypeScriptSource } from "../../../src/analysis/typescript-analyzer.js";
import {
  evaluateReadability,
  type ReadabilityRuleId,
} from "../../../src/analysis/readability.js";

function functionWithLines(name: string, statementCount: number): string {
  const statements = Array.from(
    { length: statementCount },
    (_, index) => `  const value${String(index)} = ${String(index)};`,
  ).join("\n");
  return `function ${name}() {\n${statements}\n  return value0;\n}\n`;
}

function classWithTry(name: string, statementCount: number): string {
  const statements = Array.from(
    { length: statementCount },
    (_, index) => `      const value${String(index)} = ${String(index)};`,
  ).join("\n");
  return `class ${name} {
  run() {
    try {
${statements}
      return value0;
    } catch {
      return -1;
    }
  }
}
`;
}

function namespaceWithRunner(name: string, statementCount: number): string {
  return `namespace ${name} {
${classWithTry("Runner", statementCount)}
}
`;
}

function blockOwnedHotspots(unrelated: string): string {
  const giantStatements = Array.from(
    { length: 305 },
    (_, index) => `      const giant${String(index)} = ${String(index)};`,
  ).join("\n");
  const tryStatements = Array.from(
    { length: 155 },
    (_, index) => `      const attempt${String(index)} = ${String(index)};`,
  ).join("\n");
  return `function outer() {
  {
    ${unrelated}
    function giant() {
${giantStatements}
      return giant0;
    }
    try {
${tryStatements}
      return attempt0;
    } finally {}
  }
}
`;
}

function literalConditionTries(
  first: readonly [value: string, statements: number],
  second: readonly [value: string, statements: number],
): string {
  const branch = ([value, statements]: typeof first): string => `
  if (mode === ${JSON.stringify(value)}) {
    try {
${Array.from(
  { length: statements },
  (_, index) => `      const value${String(index)} = ${String(index)};`,
).join("\n")}
      return value0;
    } finally {}
  }`;
  return `function run(mode: string) {${branch(first)}${branch(second)}
}
`;
}

function siblingBlockHotspots(order: readonly string[]): string {
  const target = (): string => {
    const giant = Array.from(
      { length: 305 },
      (_, index) => `      const giant${String(index)} = ${String(index)};`,
    ).join("\n");
    const attempts = Array.from(
      { length: 155 },
      (_, index) => `      const attempt${String(index)} = ${String(index)};`,
    ).join("\n");
    return `  {
    function giant() {
${giant}
      return giant0;
    }
    try {
${attempts}
      return attempt0;
    } finally {}
  }`;
  };
  const helper = (name: string): string => `  {
    function ${name}() { return ${JSON.stringify(name)}; }
    try { ${name}(); } finally {}
  }`;
  return `function outer() {
${order.map((name) => (name === "target" ? target() : helper(name))).join("\n")}
}
`;
}

function tryOnlySiblingHotspots(order: readonly string[]): string {
  const target = (name: string): string => {
    const statementCount = name === "wideOperation" ? 155 : 2;
    const statements = Array.from(
      { length: statementCount },
      (_, index) => `      const attempt${String(index)} = ${String(index)};`,
    ).join("\n");
    return `  {
    try {
      ${name}();
${statements}
      return attempt0;
    } finally {}
  }`;
  };
  return `function run() {
${order.map(target).join("\n")}
}
`;
}

function withFunctionMetrics(
  overrides: Partial<FunctionMetrics>,
): SourceAnalysisResult {
  const analysis = analyzeTypeScriptSource(
    "metric-delta.ts",
    "function subject() { return 1; }\n",
  );
  const unit = analysis.functions[0];
  if (unit === undefined)
    throw new Error("Expected synthetic function metrics");
  return { ...analysis, functions: [{ ...unit, ...overrides }] };
}

interface RuleMetricCase {
  readonly ruleId: ReadabilityRuleId;
  readonly introduced: Partial<FunctionMetrics>;
  readonly absent: Partial<FunctionMetrics>;
  readonly higher: Partial<FunctionMetrics>;
  readonly lower: Partial<FunctionMetrics>;
}

const RULE_METRIC_CASES: readonly RuleMetricCase[] = [
  {
    ruleId: "CQ-READ-004",
    absent: { nestedTernaryDepth: 0 },
    introduced: { nestedTernaryDepth: 2 },
    lower: { nestedTernaryDepth: 2 },
    higher: { nestedTernaryDepth: 3 },
  },
  {
    ruleId: "CQ-READ-005",
    absent: { implicitStateBranchCount: 0 },
    introduced: { implicitStateBranchCount: 1 },
    lower: { implicitStateBranchCount: 1 },
    higher: { implicitStateBranchCount: 2 },
  },
  {
    ruleId: "CQ-READ-006",
    absent: { distinctReturnObjectShapes: [] },
    introduced: { distinctReturnObjectShapes: ["a", "b"] },
    lower: { distinctReturnObjectShapes: ["a", "b"] },
    higher: { distinctReturnObjectShapes: ["a", "b", "c"] },
  },
  {
    ruleId: "CQ-READ-007",
    absent: { broadErrorStringClassificationCount: 0 },
    introduced: { broadErrorStringClassificationCount: 1 },
    lower: { broadErrorStringClassificationCount: 1 },
    higher: { broadErrorStringClassificationCount: 2 },
  },
  {
    ruleId: "CQ-READ-008",
    absent: {
      awaitCount: 1,
      decisionCount: 1,
      maximumDecisionOutcomeDistanceLines: 0,
      returnCount: 1,
    },
    introduced: {
      awaitCount: 1,
      decisionCount: 1,
      maximumDecisionOutcomeDistanceLines: 90,
      returnCount: 1,
    },
    lower: {
      awaitCount: 1,
      decisionCount: 1,
      maximumDecisionOutcomeDistanceLines: 90,
      returnCount: 1,
    },
    higher: {
      awaitCount: 1,
      decisionCount: 1,
      maximumDecisionOutcomeDistanceLines: 120,
      returnCount: 1,
    },
  },
];

describe("evaluateReadability", () => {
  test("keeps simple fallback and single ternary code free of CQ-READ-004 candidates", () => {
    const analysis = analyzeTypeScriptSource(
      "simple.ts",
      `function select(value: string | undefined, enabled: boolean) {
  const resolved = value ?? "default";
  return enabled ? resolved : "disabled";
}
`,
    );

    const report = evaluateReadability(analysis);

    expect(report.gate).toBe("PASS");
    expect(report.candidates.map(({ ruleId }) => ruleId)).not.toContain(
      "CQ-READ-004",
    );
  });

  test("maps the synthetic orchestration pattern to the intended evidence rules", async () => {
    const fixture = await readFile(
      new URL("../../fixtures/readability/octopus-pattern.ts", import.meta.url),
      "utf8",
    );
    const repeatedSteps = Array.from(
      { length: 155 },
      (_, index) =>
        `    const checkpoint${String(index)} = await loadCheckpoint(${String(index)});`,
    ).join("\n");
    const source = fixture.replace(
      "    // SYNTHETIC_REPETITIVE_STEPS",
      repeatedSteps,
    );

    const analysis = analyzeTypeScriptSource(
      "synthetic-orchestrator.ts",
      source,
    );
    const report = evaluateReadability(analysis);
    const rules = new Set(report.candidates.map(({ ruleId }) => ruleId));

    expect(analysis.complete).toBe(true);
    expect([...rules]).toEqual(
      expect.arrayContaining([
        "CQ-READ-001",
        "CQ-READ-003",
        "CQ-READ-004",
        "CQ-READ-006",
        "CQ-READ-007",
        "CQ-READ-008",
      ]),
    );
    expect(report.gate).toBe("BLOCK");
    expect(
      report.candidates.find(({ ruleId }) => ruleId === "CQ-READ-001"),
    ).toMatchObject({
      classification: "new",
      severity: "P2",
      gateImpact: "block",
      hardGate: false,
    });
  });

  test("hard-blocks new functions above 300 lines and new files above 1000 lines", () => {
    const source = `${Array.from({ length: 700 }, () => "// file context").join("\n")}\n${functionWithLines("giant", 305)}`;
    const analysis = analyzeTypeScriptSource("new-hotspot.ts", source);

    const report = evaluateReadability(analysis);

    expect(report.gate).toBe("BLOCK");
    expect(report.candidates).toContainEqual(
      expect.objectContaining({
        ruleId: "CQ-READ-001",
        hardGate: true,
        requiresWaiver: true,
      }),
    );
    expect(report.candidates).toContainEqual(
      expect.objectContaining({
        ruleId: "CQ-READ-002",
        hardGate: true,
        requiresWaiver: true,
      }),
    );
  });

  test("keeps the repository manifest below the large-file review threshold", async () => {
    const source = await readFile(
      new URL("../../../src/git/repository-manifest.ts", import.meta.url),
      "utf8",
    );
    const analysis = analyzeTypeScriptSource(
      "src/git/repository-manifest.ts",
      source,
    );

    const report = evaluateReadability(analysis);

    expect(analysis.complete).toBe(true);
    expect(
      report.candidates.some(({ ruleId }) => ruleId === "CQ-READ-002"),
    ).toBe(false);
  });

  test("keeps remediated production hotspots below their readability signals", async () => {
    const expectations = [
      [
        "analysis/typescript-identities.ts",
        "createStructuralIdentityIndex",
        ["CQ-READ-001"],
      ],
      ["core/findings.ts", "decideGate", ["CQ-READ-004"]],
      ["core/findings.ts", "dedupeFindings", ["CQ-READ-004"]],
      [
        "forges/github.ts",
        "read",
        ["CQ-READ-001", "CQ-READ-004", "CQ-READ-008"],
      ],
      ["forges/gitlab.ts", "read", ["CQ-READ-001", "CQ-READ-008"]],
      ["git/commands.ts", "runGitCommand", ["CQ-READ-001"]],
      [
        "git/repository-manifest.ts",
        "collectRepositoryManifest",
        ["CQ-READ-006"],
      ],
      ["providers/claude-cli.ts", "parseResponse", ["CQ-READ-004"]],
      ["providers/http.ts", "redactDiagnostic", ["CQ-READ-004"]],
      [
        "providers/process-provider.ts",
        "runProcess",
        ["CQ-READ-005", "CQ-READ-006"],
      ],
      ["reporters/review-terminal.ts", "renderReviewTerminal", ["CQ-READ-001"]],
      ["review/orchestrator.ts", "runReview", ["CQ-READ-004"]],
      ["review/planner.ts", "planReview", ["CQ-READ-004"]],
      ["review/prompts.ts", "buildStagePrompt", ["CQ-READ-004"]],
      ["storage/cache.ts", "publishCacheEntry", ["CQ-READ-004"]],
      ["storage/cache.ts", "readCacheEntry", ["CQ-READ-004"]],
    ] as const;
    const failures: string[] = [];

    for (const [relativePath, symbol, ruleIds] of expectations) {
      const source = await readFile(
        new URL(`../../../src/${relativePath}`, import.meta.url),
        "utf8",
      );
      const report = evaluateReadability(
        analyzeTypeScriptSource(`src/${relativePath}`, source),
      );
      const expectedRules = new Set<string>(ruleIds);
      for (const candidate of report.candidates) {
        if (
          candidate.symbol === symbol &&
          expectedRules.has(candidate.ruleId)
        ) {
          failures.push(`${relativePath}:${symbol}:${candidate.ruleId}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test("classifies baseline hotspots as expanded, improved, unchanged, or new", () => {
    const baseline = analyzeTypeScriptSource(
      "hotspots.ts",
      `${functionWithLines("expanded", 90)}${functionWithLines("improved", 100)}${functionWithLines("unchanged", 90)}`,
    );
    const current = analyzeTypeScriptSource(
      "hotspots.ts",
      `${functionWithLines("expanded", 100)}${functionWithLines("improved", 90)}${functionWithLines("unchanged", 90)}${functionWithLines("introduced", 90)}`,
    );

    const report = evaluateReadability(current, baseline);
    const classifications = new Map(
      report.candidates
        .filter(({ ruleId }) => ruleId === "CQ-READ-001")
        .map(
          (candidate) =>
            [candidate.symbol ?? "", candidate.classification] as const,
        ),
    );

    expect(classifications.get("expanded")).toBe("expanded");
    expect(classifications.get("improved")).toBe("improved");
    expect(classifications.get("unchanged")).toBe("unchanged");
    expect(classifications.get("introduced")).toBe("new");
  });

  test("maps a three-variant switch-only state model to CQ-READ-005", () => {
    const analysis = analyzeTypeScriptSource(
      "implicit-state.ts",
      `function transition(state: string) {
  switch (state) {
    case "created": return "running";
    case "running": return "complete";
    case "failed": return "created";
    default: return "failed";
  }
}
`,
    );

    const report = evaluateReadability(analysis);

    expect(report.candidates).toContainEqual(
      expect.objectContaining({
        ruleId: "CQ-READ-005",
        symbol: "transition",
      }),
    );
  });

  test("reports incomplete analysis instead of producing a misleading gate", () => {
    const analysis = analyzeTypeScriptSource("limited.ts", "const value = 1;", {
      maxNodes: 1,
    });

    const report = evaluateReadability(analysis);

    expect(report.gate).toBe("INCOMPLETE");
    expect(report.candidates).toEqual([]);
  });

  test("matches duplicate method and try baselines by qualified structural identity", () => {
    const baseline = analyzeTypeScriptSource(
      "classes.ts",
      `${classWithTry("A", 90)}${classWithTry("B", 100)}`,
    );
    const current = analyzeTypeScriptSource(
      "classes.ts",
      `${classWithTry("B", 90)}${classWithTry("A", 100)}`,
    );

    const report = evaluateReadability(current, baseline);
    const functionClassifications = new Map(
      report.candidates
        .filter(({ ruleId }) => ruleId === "CQ-READ-001")
        .map(({ classification, symbolId }) => [symbolId, classification]),
    );
    const tryClassifications = new Map(
      report.candidates
        .filter(({ ruleId }) => ruleId === "CQ-READ-003")
        .map(({ classification, symbolId }) => [symbolId, classification]),
    );
    const tryIdsByOwner = new Map(
      current.tryBlocks.map(({ ownerSymbolId, symbolId }) => [
        ownerSymbolId,
        symbolId,
      ]),
    );

    expect(functionClassifications.get("class:A#1/method:run#1")).toBe(
      "expanded",
    );
    expect(functionClassifications.get("class:B#1/method:run#1")).toBe(
      "improved",
    );
    expect(
      tryClassifications.get(tryIdsByOwner.get("class:A#1/method:run#1") ?? ""),
    ).toBe("expanded");
    expect(
      tryClassifications.get(tryIdsByOwner.get("class:B#1/method:run#1") ?? ""),
    ).toBe("improved");
  });

  test.each(RULE_METRIC_CASES)(
    "$ruleId classifies an introduced signal as expanded without a line-count change",
    ({ absent, introduced, ruleId }) => {
      const report = evaluateReadability(
        withFunctionMetrics(introduced),
        withFunctionMetrics(absent),
      );

      expect(
        report.candidates.find((candidate) => candidate.ruleId === ruleId),
      ).toMatchObject({ classification: "expanded", ruleId });
    },
  );

  test.each(RULE_METRIC_CASES)(
    "$ruleId classifies a reduced signal as improved without a line-count change",
    ({ higher, lower, ruleId }) => {
      const report = evaluateReadability(
        withFunctionMetrics(lower),
        withFunctionMetrics(higher),
      );

      expect(
        report.candidates.find((candidate) => candidate.ruleId === ruleId),
      ).toMatchObject({ classification: "improved", ruleId });
    },
  );

  test.each(RULE_METRIC_CASES)(
    "$ruleId classifies an increased signal as expanded without a line-count change",
    ({ higher, lower, ruleId }) => {
      const report = evaluateReadability(
        withFunctionMetrics(higher),
        withFunctionMetrics(lower),
      );

      expect(
        report.candidates.find((candidate) => candidate.ruleId === ruleId),
      ).toMatchObject({ classification: "expanded", ruleId });
    },
  );

  test("returns INCOMPLETE without candidates when a supplied baseline is incomplete", () => {
    const current = analyzeTypeScriptSource(
      "current.ts",
      functionWithLines("giant", 305),
    );
    const incompleteBaseline = analyzeTypeScriptSource(
      "baseline.ts",
      "function broken( {",
    );

    const report = evaluateReadability(current, incompleteBaseline);

    expect(report).toMatchObject({ gate: "INCOMPLETE", candidates: [] });
  });

  test("keeps reordered namespace-owned methods and tries independent across baselines", () => {
    const baseline = analyzeTypeScriptSource(
      "namespaces.ts",
      `${namespaceWithRunner("A", 90)}${namespaceWithRunner("B", 100)}`,
    );
    const current = analyzeTypeScriptSource(
      "namespaces.ts",
      `${namespaceWithRunner("B", 90)}${namespaceWithRunner("A", 100)}`,
    );

    const report = evaluateReadability(current, baseline);
    const functions = new Map(
      report.candidates
        .filter(({ ruleId }) => ruleId === "CQ-READ-001")
        .map(({ classification, symbolId }) => [symbolId, classification]),
    );
    const tries = new Map(
      report.candidates
        .filter(({ ruleId }) => ruleId === "CQ-READ-003")
        .map(({ classification, symbolId }) => [symbolId, classification]),
    );
    const tryIdsByOwner = new Map(
      current.tryBlocks.map(({ ownerSymbolId, symbolId }) => [
        ownerSymbolId,
        symbolId,
      ]),
    );

    expect(functions.get("namespace:A#1/class:Runner#1/method:run#1")).toBe(
      "expanded",
    );
    expect(functions.get("namespace:B#1/class:Runner#1/method:run#1")).toBe(
      "improved",
    );
    expect(
      tries.get(
        tryIdsByOwner.get("namespace:A#1/class:Runner#1/method:run#1") ?? "",
      ),
    ).toBe("expanded");
    expect(
      tries.get(
        tryIdsByOwner.get("namespace:B#1/class:Runner#1/method:run#1") ?? "",
      ),
    ).toBe("improved");
  });

  test("rejects duplicate structural IDs instead of choosing an arbitrary baseline", () => {
    const analysis = analyzeTypeScriptSource(
      "duplicates.ts",
      "function first() { return 1; } function second() { return 2; }",
    );
    const first = analysis.functions[0];
    const second = analysis.functions[1];
    if (first === undefined || second === undefined) {
      throw new Error("Expected duplicate-ID test functions");
    }
    const duplicateBaseline: SourceAnalysisResult = {
      ...analysis,
      functions: [first, { ...second, symbolId: first.symbolId }],
    };

    const report = evaluateReadability(analysis, duplicateBaseline);

    expect(report).toMatchObject({ gate: "INCOMPLETE", candidates: [] });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_STRUCTURAL_ID",
        symbolId: first.symbolId,
      }),
    );
  });

  test("bounds baseline identity indexing and lookup operations linearly", () => {
    const analysis = analyzeTypeScriptSource(
      "large-baseline.ts",
      "function subject() { return 1; }",
    );
    const subject = analysis.functions[0];
    if (subject === undefined) throw new Error("Expected baseline subject");
    const count = 5_000;
    const functions = Array.from({ length: count }, (_, index) => ({
      ...subject,
      name: `subject${String(index)}`,
      symbolId: `function:subject${String(index)}#1`,
    }));
    const current = { ...analysis, functions };
    const baseline = { ...analysis, functions };

    const report = evaluateReadability(current, baseline);

    expect(report.baselineMatchOperations).toBeLessThanOrEqual(count * 4);
  });

  test("CQ-READ-004 treats any component increase as expanded despite numeric cancellation", () => {
    const current = withFunctionMetrics({
      maximumNullishChainValues: 3,
      nestedTernaryDepth: 3,
    });
    const baseline = withFunctionMetrics({
      maximumNullishChainValues: 4,
      nestedTernaryDepth: 2,
    });

    const report = evaluateReadability(current, baseline);

    expect(
      report.candidates.find(({ ruleId }) => ruleId === "CQ-READ-004"),
    ).toMatchObject({ classification: "expanded" });
  });

  test("CQ-READ-006 treats shape and object counts as components with unequal units", () => {
    const analysis = withFunctionMetrics({});
    const unit = analysis.functions[0];
    if (unit === undefined) throw new Error("Expected result-shape subject");
    const objectEvidence = {
      range: unit.range,
      propertyCount: 8,
      shape: "synthetic",
    };
    const current = withFunctionMetrics({
      distinctReturnObjectShapes: ["a", "b"],
      largeObjectLiterals: [objectEvidence, objectEvidence],
    });
    const baseline = withFunctionMetrics({
      distinctReturnObjectShapes: ["a", "b", "c"],
      largeObjectLiterals: [objectEvidence],
    });

    const report = evaluateReadability(current, baseline);

    expect(
      report.candidates.find(({ ruleId }) => ruleId === "CQ-READ-006"),
    ).toMatchObject({ classification: "expanded" });
  });

  test("CQ-READ-008 treats an increased enabling metric as expanded despite shorter distance", () => {
    const current = withFunctionMetrics({
      awaitCount: 1,
      decisionCount: 2,
      maximumDecisionOutcomeDistanceLines: 90,
      returnCount: 1,
    });
    const baseline = withFunctionMetrics({
      awaitCount: 1,
      decisionCount: 1,
      maximumDecisionOutcomeDistanceLines: 100,
      returnCount: 1,
    });

    const report = evaluateReadability(current, baseline);

    expect(
      report.candidates.find(({ ruleId }) => ruleId === "CQ-READ-008"),
    ).toMatchObject({ classification: "expanded" });
  });

  test("keeps block-owned hotspot identities stable across unrelated sibling edits", () => {
    const baseline = analyzeTypeScriptSource(
      "block-hotspots.ts",
      blockOwnedHotspots("const note = 1; const removed = 2;"),
    );
    const current = analyzeTypeScriptSource(
      "block-hotspots.ts",
      blockOwnedHotspots("const note = 99; const added = 3;"),
    );

    const report = evaluateReadability(current, baseline);
    const giant = report.candidates.find(
      ({ ruleId, symbol }) => ruleId === "CQ-READ-001" && symbol === "giant",
    );
    const wideTry = report.candidates.find(
      ({ ruleId }) => ruleId === "CQ-READ-003",
    );

    expect(giant).toMatchObject({
      classification: "unchanged",
      hardGate: false,
    });
    expect(wideTry).toMatchObject({ classification: "unchanged" });
  });

  test("preserves literal whitespace when matching reordered condition-owned tries", () => {
    const baseline = analyzeTypeScriptSource(
      "literal-conditions.ts",
      literalConditionTries(["a b", 90], ["ab", 100]),
    );
    const current = analyzeTypeScriptSource(
      "literal-conditions.ts",
      literalConditionTries(["ab", 90], ["a b", 100]),
    );

    const report = evaluateReadability(current, baseline);
    const classifications = report.candidates
      .filter(({ ruleId }) => ruleId === "CQ-READ-003")
      .map(({ classification }) => classification)
      .sort();

    expect(classifications).toEqual(["expanded", "improved"]);
  });

  test("keeps target hotspot IDs stable when differently named sibling blocks change order", () => {
    const baseline = analyzeTypeScriptSource(
      "sibling-blocks.ts",
      siblingBlockHotspots(["target", "helperAlpha", "helperBeta"]),
    );
    const current = analyzeTypeScriptSource(
      "sibling-blocks.ts",
      siblingBlockHotspots(["helperBeta", "target", "helperGamma"]),
    );

    const baselineGiant = baseline.functions.find(
      ({ name }) => name === "giant",
    );
    const currentGiant = current.functions.find(({ name }) => name === "giant");
    const baselineWideTry = baseline.tryBlocks.find(
      ({ range }) => range.lineSpan > 80,
    );
    const currentWideTry = current.tryBlocks.find(
      ({ range }) => range.lineSpan > 80,
    );
    const report = evaluateReadability(current, baseline);

    expect(currentGiant?.symbolId).toBe(baselineGiant?.symbolId);
    expect(currentWideTry?.symbolId).toBe(baselineWideTry?.symbolId);
    expect(
      report.candidates.find(
        ({ ruleId, symbol }) => ruleId === "CQ-READ-001" && symbol === "giant",
      ),
    ).toMatchObject({ classification: "unchanged", hardGate: false });
    expect(
      report.candidates.find(({ ruleId }) => ruleId === "CQ-READ-003"),
    ).toMatchObject({ classification: "unchanged" });
  });

  test("keeps named block-owned hotspots stable when the same block gains a helper", () => {
    const baseline = analyzeTypeScriptSource(
      "block-helper.ts",
      blockOwnedHotspots(""),
    );
    const current = analyzeTypeScriptSource(
      "block-helper.ts",
      blockOwnedHotspots("function helper() { return 1; }"),
    );
    const baselineGiant = baseline.functions.find(
      ({ name }) => name === "giant",
    );
    const currentGiant = current.functions.find(({ name }) => name === "giant");
    const baselineWideTry = baseline.tryBlocks.find(
      ({ range }) => range.lineSpan > 80,
    );
    const currentWideTry = current.tryBlocks.find(
      ({ range }) => range.lineSpan > 80,
    );
    const report = evaluateReadability(current, baseline);

    expect(currentGiant?.symbolId).toBe(baselineGiant?.symbolId);
    expect(currentWideTry?.symbolId).toBe(baselineWideTry?.symbolId);
    expect(
      report.candidates.find(
        ({ ruleId, symbol }) => ruleId === "CQ-READ-001" && symbol === "giant",
      ),
    ).toMatchObject({ classification: "unchanged", hardGate: false });
    expect(
      report.candidates.find(({ ruleId }) => ruleId === "CQ-READ-003"),
    ).toMatchObject({ classification: "unchanged" });
  });

  test("keeps distinct try-only sibling hotspots stable across insertion and reordering", () => {
    const baseline = analyzeTypeScriptSource(
      "try-only-blocks.ts",
      tryOnlySiblingHotspots(["wideOperation", "smallOperation"]),
    );
    const current = analyzeTypeScriptSource(
      "try-only-blocks.ts",
      tryOnlySiblingHotspots([
        "smallOperation",
        "auditOperation",
        "wideOperation",
      ]),
    );
    const baselineWideTry = baseline.tryBlocks.find(
      ({ range }) => range.lineSpan > 80,
    );
    const currentWideTry = current.tryBlocks.find(
      ({ range }) => range.lineSpan > 80,
    );
    const report = evaluateReadability(current, baseline);

    expect(currentWideTry?.symbolId).toBe(baselineWideTry?.symbolId);
    expect(
      report.candidates.find(
        ({ ruleId, symbolId }) =>
          ruleId === "CQ-READ-003" && symbolId === currentWideTry?.symbolId,
      ),
    ).toMatchObject({ classification: "unchanged" });
  });
});
