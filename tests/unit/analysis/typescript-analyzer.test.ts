import { describe, expect, test } from "vitest";

import type { AnalysisLimits } from "../../../src/analysis/language-analyzer.js";
import {
  analyzeTypeScriptSource,
  createTypeScriptAnalyzer,
} from "../../../src/analysis/typescript-analyzer.js";

const COMPLEX_SOURCE = `
async function exportOrchestrator(
  input: { primary?: string; secondary?: string } | undefined,
  enabled: boolean,
) {
  const fallback = "fallback";
  const selected =
    input?.primary ?? input?.secondary ?? (enabled ? fallback : "disabled");

  if (selected && enabled) {
    await publish({
      status: "started",
      selected,
      attempt: 1,
      total: 2,
      created: true,
      cached: false,
      source: "synthetic",
      version: 1,
    });
  }

  try {
    const label = enabled ? (selected ? "ready" : "empty") : "disabled";
    return enabled
      ? {
          status: "complete",
          label,
          selected,
          attempt: 1,
          total: 2,
          created: true,
          cached: false,
          version: 1,
        }
      : { status: "skipped", reason: label };
  } catch (error) {
    if (error instanceof Error && error.message.includes("timeout")) {
      return { status: "failed", reason: error.message };
    }
    throw error;
  }
}
`;

describe("analyzeTypeScriptSource", () => {
  test("reports source-ranged function, try, flow, fallback, and result-shape metrics", () => {
    const report = analyzeTypeScriptSource("example.ts", COMPLEX_SOURCE);

    expect(report.complete).toBe(true);
    expect(report.diagnostics).toEqual([]);
    expect(report.file.range.lineSpan).toBe(COMPLEX_SOURCE.split("\n").length);
    expect(report.functions).toHaveLength(1);

    const unit = report.functions[0];
    expect(unit).toBeDefined();
    expect(unit).toMatchObject({
      name: "exportOrchestrator",
      kind: "function",
      awaitCount: 1,
      catchCount: 1,
      localDeclarationCount: 3,
      returnCount: 2,
      nestedTernaryDepth: 2,
      maximumNullishChainValues: 3,
      maximumNullishChainSemanticSources: 2,
      broadErrorStringClassificationCount: 1,
    });
    expect(unit?.decisionCount).toBeGreaterThanOrEqual(5);
    expect(unit?.maxControlNesting).toBeGreaterThanOrEqual(2);
    expect(unit?.mixedConditionalFallbackExpressions.length).toBeGreaterThan(0);
    expect(unit?.largeObjectLiterals).toHaveLength(2);
    expect(unit?.distinctReturnObjectShapes).toHaveLength(3);
    expect(
      COMPLEX_SOURCE.slice(unit?.range.start.offset, unit?.range.end.offset),
    ).toMatch(/^async function exportOrchestrator/u);

    expect(report.tryBlocks).toHaveLength(1);
    const tryBlock = report.tryBlocks[0];
    expect(tryBlock).toMatchObject({
      ownerName: "exportOrchestrator",
      awaitCount: 0,
      catchCount: 1,
      returnCount: 1,
    });
    expect(
      COMPLEX_SOURCE.slice(
        tryBlock?.range.start.offset,
        tryBlock?.range.end.offset,
      ),
    ).toMatch(/^\{/u);
  });

  test("does not flag a simple default or an ordinary single ternary as mixed", () => {
    const source = `
function select(value: string | undefined, enabled: boolean) {
  const resolved = value ?? "default";
  return enabled ? resolved : "disabled";
}
`;

    const report = analyzeTypeScriptSource("simple.ts", source);
    const unit = report.functions[0];

    expect(unit).toMatchObject({
      maximumNullishChainValues: 2,
      maximumNullishChainSemanticSources: 1,
      nestedTernaryDepth: 1,
    });
    expect(unit?.mixedConditionalFallbackExpressions).toEqual([]);
  });

  test("analyzes methods, arrow functions, and JavaScript with stable ranges", () => {
    const source = `class Runner {
  run(value) {
    try {
      return value || "fallback";
    } catch (error) {
      return "failed";
    }
  }
}

const choose = (value) => value?.name ?? "anonymous";
`;

    const analyzer = createTypeScriptAnalyzer();
    expect(analyzer.supports("runner.js")).toBe(true);
    expect(analyzer.supports("view.jsx")).toBe(true);
    expect(analyzer.supports("module.tsx")).toBe(true);
    expect(analyzer.supports("worker.py")).toBe(false);

    const report = analyzer.analyze({ path: "runner.js", source });

    expect(report.functions.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: "method", name: "run" },
      { kind: "arrow", name: "choose" },
    ]);
    expect(report.tryBlocks[0]?.ownerName).toBe("run");
    expect(report.functions[0]?.range.start.line).toBe(2);
    expect(report.functions[1]?.range.start.line).toBe(11);
  });

  test("returns explicit parser diagnostics without executing or typechecking source", () => {
    const source = `
const missingRuntimeName: ImpossibleType = unavailableRuntimeValue;
function broken( {
`;

    const report = analyzeTypeScriptSource("broken.ts", source);

    expect(report.complete).toBe(false);
    expect(report.diagnostics[0]?.category).toBe("parser");
    expect(report.diagnostics[0]?.code).toMatch(/^TS\d+$/u);
    expect(report.diagnostics[0]?.path).toBe("broken.ts");
  });

  test("stops before parsing sources above the bounded byte limit", () => {
    const report = analyzeTypeScriptSource(
      "large.ts",
      "export const content = 'bounded';",
      { maxBytes: 16 },
    );

    expect(report.complete).toBe(false);
    expect(report.functions).toEqual([]);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        category: "incomplete",
        code: "SOURCE_TOO_LARGE",
      }),
    ]);
  });

  test("stops iterative traversal at the bounded AST node limit", () => {
    const source = Array.from(
      { length: 20 },
      (_, index) => `const value${String(index)} = ${String(index)};`,
    ).join("\n");

    const report = analyzeTypeScriptSource("many-nodes.ts", source, {
      maxNodes: 10,
    });

    expect(report.complete).toBe(false);
    expect(report.functions).toEqual([]);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        category: "incomplete",
        code: "AST_NODE_LIMIT_EXCEEDED",
      }),
    );
  });

  test("keeps expression traversal work linear as nullish chains grow", () => {
    const sourceWithValues = (count: number): string =>
      `function choose(input: Record<string, string | undefined>) {
  return ${Array.from({ length: count }, (_, index) => `input.value${String(index)}`).join(" ?? ")};
}`;

    const smaller = analyzeTypeScriptSource("smaller.ts", sourceWithValues(80));
    const larger = analyzeTypeScriptSource("larger.ts", sourceWithValues(160));

    expect(smaller.complete).toBe(true);
    expect(larger.complete).toBe(true);
    expect(larger.analysisWork.totalNodeVisits).toBeLessThanOrEqual(
      smaller.analysisWork.totalNodeVisits * 3,
    );
    expect(larger.analysisWork.structuralRoleOperations).toBeLessThanOrEqual(
      smaller.analysisWork.structuralRoleOperations * 3,
    );
    expect(larger.analysisWork.structuralRoleOperations).toBeLessThanOrEqual(
      larger.visitedNodes * 4,
    );
    expect(larger.analysisWork.totalNodeVisits).toBeLessThanOrEqual(
      larger.visitedNodes * 16,
    );
  });

  test("assigns class-qualified structural identities to duplicate method and try names", () => {
    const source = `class A {
  run() {
    try { return "a"; } catch { return "failed-a"; }
  }
}
class B {
  run() {
    try { return "b"; } catch { return "failed-b"; }
  }
}`;

    const report = analyzeTypeScriptSource("classes.ts", source);

    expect(report.functions.map(({ symbolId }) => symbolId)).toEqual([
      "class:A#1/method:run#1",
      "class:B#1/method:run#1",
    ]);
    expect(report.tryBlocks.map(({ ownerSymbolId }) => ownerSymbolId)).toEqual([
      "class:A#1/method:run#1",
      "class:B#1/method:run#1",
    ]);
    expect(report.tryBlocks[0]?.symbolId).toMatch(
      /^class:A#1\/method:run#1\/try:[0-9a-f]+#1$/u,
    );
    expect(report.tryBlocks[1]?.symbolId).toMatch(
      /^class:B#1\/method:run#1\/try:[0-9a-f]+#1$/u,
    );
  });

  test("treats function overload signatures as one stable implementation unit", () => {
    const before = analyzeTypeScriptSource(
      "overload.ts",
      `function parse(value: string): string;
function parse(value: number): number;
function parse(value: string | number) { return String(value); }`,
    );
    const after = analyzeTypeScriptSource(
      "overload.ts",
      `function parse(value: boolean): string;
function parse(value: number): number;
function parse(value: string): string;
function parse(value: string | number | boolean) { return String(value); }`,
    );

    expect(before.complete).toBe(true);
    expect(after.complete).toBe(true);
    expect(before.functions.map(({ symbolId }) => symbolId)).toEqual([
      "function:parse#1",
    ]);
    expect(after.functions.map(({ symbolId }) => symbolId)).toEqual([
      "function:parse#1",
    ]);
  });

  test("distinguishes getter and setter roles independently of their order", () => {
    const source = (setterFirst: boolean): string => {
      const getter = "get value() { return this.current; }";
      const setter = "set value(next: number) { this.current = next; }";
      return `class Accessor { private current = 0; ${setterFirst ? `${setter} ${getter}` : `${getter} ${setter}`} }`;
    };
    const before = analyzeTypeScriptSource("accessor.ts", source(false));
    const after = analyzeTypeScriptSource("accessor.ts", source(true));
    const ids = (report: typeof before): readonly string[] =>
      report.functions.map(({ symbolId }) => symbolId).sort();

    expect(before.complete).toBe(true);
    expect(after.complete).toBe(true);
    expect(ids(before)).toEqual([
      "class:Accessor#1/getter:value#1",
      "class:Accessor#1/setter:value#1",
    ]);
    expect(ids(after)).toEqual(ids(before));
  });

  test("distinguishes static and instance methods independently of their order", () => {
    const source = (staticFirst: boolean): string => {
      const instance = "run() { return 'instance'; }";
      const staticMethod = "static run() { return 'static'; }";
      return `class Runner { ${staticFirst ? `${staticMethod} ${instance}` : `${instance} ${staticMethod}`} }`;
    };
    const before = analyzeTypeScriptSource("static-method.ts", source(false));
    const after = analyzeTypeScriptSource("static-method.ts", source(true));
    const ids = (report: typeof before): readonly string[] =>
      report.functions.map(({ symbolId }) => symbolId).sort();

    expect(before.complete).toBe(true);
    expect(after.complete).toBe(true);
    expect(ids(before)).toEqual([
      "class:Runner#1/method:run#1",
      "class:Runner#1/static-method:run#1",
    ]);
    expect(ids(after)).toEqual(ids(before));
  });

  test("treats constructor overload signatures as one implementation unit", () => {
    const before = analyzeTypeScriptSource(
      "constructor-overload.ts",
      `class Subject {
  constructor(value: string);
  constructor(value: number);
  constructor(readonly value: string | number) {}
}`,
    );
    const after = analyzeTypeScriptSource(
      "constructor-overload.ts",
      `class Subject {
  constructor(value: boolean);
  constructor(value: number);
  constructor(value: string);
  constructor(readonly value: string | number | boolean) {}
}`,
    );

    expect(before.complete).toBe(true);
    expect(after.complete).toBe(true);
    expect(before.functions.map(({ symbolId }) => symbolId)).toEqual([
      "class:Subject#1/constructor:constructor#1",
    ]);
    expect(after.functions.map(({ symbolId }) => symbolId)).toEqual([
      "class:Subject#1/constructor:constructor#1",
    ]);
  });

  test("fails closed for truly indistinguishable same-role methods", () => {
    const report = analyzeTypeScriptSource(
      "duplicate-method.ts",
      "class Duplicate { run() { return 1; } run() { return 2; } }",
    );

    expect(report.complete).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        category: "incomplete",
        code: "DUPLICATE_STRUCTURAL_ID",
      }),
    );
  });

  test("isolates ternary and mixed-expression metrics at nested function boundaries", () => {
    const source = `function outer(flag, input) {
  return flag
    ? (() => flag ? input?.primary ?? input.secondary : "disabled")
    : (() => flag ? input?.secondary ?? input.primary : "disabled");
}`;

    const report = analyzeTypeScriptSource("nested.ts", source);
    const [outer, firstArrow, secondArrow] = report.functions;

    expect(outer?.nestedTernaryDepth).toBe(1);
    expect(outer?.mixedConditionalFallbackExpressions).toEqual([]);
    expect(firstArrow?.nestedTernaryDepth).toBe(1);
    expect(
      firstArrow?.mixedConditionalFallbackExpressions.length,
    ).toBeGreaterThan(0);
    expect(secondArrow?.nestedTernaryDepth).toBe(1);
    expect(
      secondArrow?.mixedConditionalFallbackExpressions.length,
    ).toBeGreaterThan(0);
  });

  test("treats nested payload objects as fields rather than return variants", () => {
    const source = `function result(ok) {
  return ok
    ? { kind: "ok", payload: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 } }
    : { kind: "failed", error: { code: 1, message: "x" } };
}`;

    const report = analyzeTypeScriptSource("result.ts", source);

    expect(report.functions[0]?.distinctReturnObjectShapes).toEqual([
      "error|kind=failed",
      "kind=ok|payload",
    ]);
    expect(report.functions[0]?.largeObjectLiterals).toHaveLength(1);
  });

  test("returns an explicit incomplete diagnostic when total analysis work exceeds its bound", () => {
    const depth = 80;
    const source = `function nested() {
${Array.from({ length: depth }, () => "try {").join("\n")}
return 1;
${Array.from({ length: depth }, () => "} finally {}").join("\n")}
}`;
    const initial = analyzeTypeScriptSource("nested-tries.ts", source);

    const bounded = analyzeTypeScriptSource("nested-tries.ts", source, {
      maxNodes: initial.visitedNodes,
    });

    expect(bounded.complete).toBe(false);
    expect(bounded.diagnostics).toContainEqual(
      expect.objectContaining({
        category: "incomplete",
        code: "ANALYSIS_WORK_LIMIT_EXCEEDED",
      }),
    );
  });

  test("analyzes deeply chained semantic sources without recursive helper overflow", () => {
    const access = `input${Array.from({ length: 20_000 }, () => ".value").join("")}`;
    const source = `function choose(input) { return ${access} ?? "fallback"; }`;

    const report = analyzeTypeScriptSource("deep-access.ts", source);

    expect(report.complete).toBe(true);
    expect(report.functions[0]?.maximumNullishChainSemanticSources).toBe(1);
  });

  test("keeps near-limit decision extrema out of the JavaScript call-argument stack", () => {
    const cases = Array.from(
      { length: 123_000 },
      (_, index) => `case ${String(index)}:`,
    ).join(" ");
    const source = `function inspect(value) { switch (value) { ${cases} default: return 0; } }`;

    const report = analyzeTypeScriptSource("many-decisions.ts", source);

    expect(
      report.complete ||
        report.diagnostics.some(
          ({ code }) => code === "ANALYSIS_WORK_LIMIT_EXCEEDED",
        ),
    ).toBe(true);
  }, 30_000);

  test("qualifies identical class, method, and try identities by namespace ownership", () => {
    const source = `namespace A {
  export class Runner {
    run() { try { return "a"; } catch { return "failed-a"; } }
  }
}
namespace B {
  export class Runner {
    run() { try { return "b"; } catch { return "failed-b"; } }
  }
}
declare module "vendor" {
  export function run(): void;
}`;

    const report = analyzeTypeScriptSource("namespaces.ts", source);

    expect(report.functions.map(({ symbolId }) => symbolId)).toEqual([
      "namespace:A#1/class:Runner#1/method:run#1",
      "namespace:B#1/class:Runner#1/method:run#1",
    ]);
    expect(report.tryBlocks[0]?.symbolId).toMatch(
      /^namespace:A#1\/class:Runner#1\/method:run#1\/try:[0-9a-f]+#1$/u,
    );
    expect(report.tryBlocks[1]?.symbolId).toMatch(
      /^namespace:B#1\/class:Runner#1\/method:run#1\/try:[0-9a-f]+#1$/u,
    );
  });

  test("bounds structural identity work linearly for large flat sibling sets", () => {
    const classWithMethods = (count: number): string =>
      `class Flat { ${Array.from({ length: count }, (_, index) => `method${String(index)}() { return ${String(index)}; }`).join(" ")} }`;
    const smaller = analyzeTypeScriptSource(
      "flat-small.ts",
      classWithMethods(200),
    );
    const larger = analyzeTypeScriptSource(
      "flat-large.ts",
      classWithMethods(400),
    );

    expect(
      larger.analysisWork.structuralIdentityNodeVisits,
    ).toBeLessThanOrEqual(
      smaller.analysisWork.structuralIdentityNodeVisits * 3,
    );
    expect(
      larger.analysisWork.structuralIdentityNodeVisits,
    ).toBeLessThanOrEqual(larger.visitedNodes);
  });

  test("keeps anonymous callback identities unique and stable across wrapper reordering", () => {
    const before = analyzeTypeScriptSource(
      "callbacks.ts",
      "function setup() { alpha(() => 1); beta(() => 2); }",
    );
    const after = analyzeTypeScriptSource(
      "callbacks.ts",
      "function setup() { beta(() => 2); alpha(() => 1); }",
    );
    const callbackIds = (report: typeof before): readonly string[] =>
      report.functions
        .filter(({ kind }) => kind === "arrow")
        .map(({ symbolId }) => symbolId)
        .sort();

    expect(new Set(callbackIds(before)).size).toBe(2);
    expect(callbackIds(after)).toEqual(callbackIds(before));
  });

  test("distinguishes anonymous object contexts by stable property roles", () => {
    const source = (reversed: boolean): string => {
      const first = "use(flag ? {} : { first: () => alpha() });";
      const second = "use(flag ? {} : { second: () => beta() });";
      return `function setup(flag) { ${reversed ? `${second} ${first}` : `${first} ${second}`} }`;
    };
    const before = analyzeTypeScriptSource("object-contexts.ts", source(false));
    const after = analyzeTypeScriptSource("object-contexts.ts", source(true));
    const callbackIds = (report: typeof before): readonly string[] =>
      report.functions
        .filter(({ kind }) => kind === "arrow")
        .map(({ symbolId }) => symbolId)
        .sort();

    expect(before.complete).toBe(true);
    expect(after.complete).toBe(true);
    expect(new Set(callbackIds(before)).size).toBe(2);
    expect(callbackIds(after)).toEqual(callbackIds(before));
  });

  test("distinguishes same-shape anonymous objects by initializer structure", () => {
    const report = analyzeTypeScriptSource(
      "object-initializers.ts",
      `function run(enabled, values) {
  if (!enabled) return { kind: "continue", failed: false };
  return { kind: "continue", failed: values.some((value) => value.failed) };
}`,
    );

    expect(report.complete).toBe(true);
    expect(report.functions.map(({ kind }) => kind)).toContain("arrow");
  });

  test("distinguishes nested Promise settlement callbacks by full structure", () => {
    const report = analyzeTypeScriptSource(
      "promise-settlement.ts",
      `function raceWithSignal(operation, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      finish(() => reject(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        finish(() => resolve(value));
      },
      (error) => {
        finish(() => reject(error));
      },
    );
  });
}`,
    );

    expect(report.complete).toBe(true);
  });

  test("keeps try identities unique and stable across distinct block reordering", () => {
    const source = (reversed: boolean): string => {
      const first = "if (mode === 'first') { try { return 1; } finally {} }";
      const second = "if (mode === 'second') { try { return 2; } finally {} }";
      return `function run(mode) { ${reversed ? `${second} ${first}` : `${first} ${second}`} }`;
    };
    const before = analyzeTypeScriptSource("tries.ts", source(false));
    const after = analyzeTypeScriptSource("tries.ts", source(true));
    const tryIds = (report: typeof before): readonly string[] =>
      report.tryBlocks.map(({ symbolId }) => symbolId).sort();

    expect(new Set(tryIds(before)).size).toBe(2);
    expect(tryIds(after)).toEqual(tryIds(before));
  });

  test.each([
    {
      owner: "function",
      wrap: (body: string): string => `function run() { ${body} }`,
    },
    {
      owner: "method",
      wrap: (body: string): string => `class Runner { run() { ${body} } }`,
    },
    { owner: "module", wrap: (body: string): string => body },
  ])(
    "keeps direct $owner try identities complete and stable across insertion and reordering",
    ({ wrap }) => {
      const sourceWithTargets = (targets: readonly string[]): string =>
        wrap(
          targets.map((target) => `try { ${target}(); } finally {}`).join(" "),
        );
      const beforeSource = sourceWithTargets(["alpha", "beta"]);
      const afterSource = sourceWithTargets(["gamma", "beta", "alpha"]);
      const before = analyzeTypeScriptSource("direct-tries.ts", beforeSource);
      const after = analyzeTypeScriptSource("direct-tries.ts", afterSource);
      const idsByTarget = (
        report: typeof before,
        source: string,
      ): ReadonlyMap<string, string> =>
        new Map(
          report.tryBlocks.map(({ range, symbolId }) => {
            const body = source.slice(range.start.offset, range.end.offset);
            const target = /\b(alpha|beta|gamma)\(\)/u.exec(body)?.[1];
            if (target === undefined) {
              throw new Error("Expected a direct try target");
            }
            return [target, symbolId] as const;
          }),
        );
      const beforeIds = idsByTarget(before, beforeSource);
      const afterIds = idsByTarget(after, afterSource);

      expect(before.complete).toBe(true);
      expect(after.complete).toBe(true);
      expect(new Set(beforeIds.values()).size).toBe(2);
      expect(afterIds.get("alpha")).toBe(beforeIds.get("alpha"));
      expect(afterIds.get("beta")).toBe(beforeIds.get("beta"));
    },
  );

  test("reports indistinguishable same-role direct tries instead of matching by order", () => {
    const report = analyzeTypeScriptSource(
      "ambiguous-direct-tries.ts",
      `function run() {
  try { perform(); } finally {}
  try { perform(); } finally {}
}`,
    );

    expect(report.complete).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        category: "incomplete",
        code: "DUPLICATE_STRUCTURAL_ID",
      }),
    );
  });

  test("reports indistinguishable same-role try targets instead of matching by order", () => {
    const report = analyzeTypeScriptSource(
      "ambiguous-tries.ts",
      `function run() {
  { try { perform(); } finally {} }
  { try { perform(); } finally {} }
}`,
    );

    expect(report.complete).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        category: "incomplete",
        code: "DUPLICATE_STRUCTURAL_ID",
      }),
    );
  });

  test.each(
    (["maxBytes", "maxNodes", "maxWork"] as const).flatMap((limit) =>
      [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        -1,
        1.5,
      ].map((value) => ({ limit, value })),
    ),
  )("rejects invalid $limit value $value explicitly", ({ limit, value }) => {
    const limits = { [limit]: value } as AnalysisLimits;

    const report = analyzeTypeScriptSource(
      "invalid-limit.ts",
      "const value = 1;",
      limits,
    );

    expect(report.complete).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        category: "incomplete",
        code: "INVALID_ANALYSIS_LIMIT",
      }),
    );
  });

  test("counts typed concise arrow returns and only their top-level object alternatives", () => {
    const source = `
type Result = { kind: "ok"; payload: object } | { kind: "failed"; error: object };
const choose = (ok: boolean): Result =>
  ok
    ? ({ kind: "ok", payload: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 } })
    : ({ kind: "failed", error: { code: 1, message: "x" } });
const maybe = (ok: boolean) => ok && ({ kind: "ok", payload: { nested: true } });
`;

    const report = analyzeTypeScriptSource("concise.ts", source);
    const [choose, maybe] = report.functions;

    expect(choose?.returnCount).toBe(1);
    expect(choose?.distinctReturnObjectShapes).toEqual([
      "error|kind=failed",
      "kind=ok|payload",
    ]);
    expect(choose?.largeObjectLiterals).toHaveLength(1);
    expect(maybe?.returnCount).toBe(1);
    expect(maybe?.distinctReturnObjectShapes).toEqual(["kind=ok|payload"]);
  });

  test.each(["module.mjs", "module.cjs", "module.mts", "module.cts"])(
    "supports modern Node module extension %s",
    (path) => {
      expect(createTypeScriptAnalyzer().supports(path)).toBe(true);
    },
  );

  test.each(["module.mjs", "module.cjs"])(
    "routes %s through the JavaScript parser mode",
    (path) => {
      const report = analyzeTypeScriptSource(path, "const value: number = 1;");

      expect(report.language).toBe("javascript");
    },
  );

  test.each(["module.mts", "module.cts"])(
    "parses %s with TypeScript grammar",
    (path) => {
      const report = analyzeTypeScriptSource(path, "const value: number = 1;");

      expect(report.complete).toBe(true);
      expect(report.language).toBe("typescript");
    },
  );

  test("bounds wrapper fingerprint work and identity size for a deep callback callee", () => {
    const source = `const value = (() => 1)${"()".repeat(1_000)};`;

    const report = analyzeTypeScriptSource("deep-callback.ts", source);
    const callback = report.functions[0];

    expect(report.complete).toBe(true);
    expect(
      report.analysisWork.structuralFingerprintNodeVisits,
    ).toBeLessThanOrEqual(report.visitedNodes);
    expect(report.analysisWork.structuralPathOperations).toBeLessThanOrEqual(
      report.visitedNodes,
    );
    expect(callback?.symbolId.length).toBeLessThan(512);
  });

  test("keeps 16k, 32k, and 64k deep call analysis bounded or explicitly incomplete", () => {
    const depths = [16_000, 32_000, 64_000] as const;
    const reports = depths.map((depth) =>
      analyzeTypeScriptSource(
        `deep-${String(depth)}.ts`,
        `const value = (() => 1)${"()".repeat(depth)};`,
      ),
    );

    for (const report of reports) {
      expect(
        report.complete ||
          report.diagnostics.some(
            ({ code }) => code === "ANALYSIS_WORK_LIMIT_EXCEEDED",
          ),
      ).toBe(true);
      expect(
        report.analysisWork.structuralFingerprintNodeVisits,
      ).toBeLessThanOrEqual(report.visitedNodes);
      expect(report.analysisWork.structuralPathOperations).toBeLessThanOrEqual(
        report.visitedNodes,
      );
      expect(report.functions[0]?.symbolId.length ?? 0).toBeLessThan(512);
    }
    expect(reports[1]?.analysisWork.totalNodeVisits).toBeLessThanOrEqual(
      (reports[0]?.analysisWork.totalNodeVisits ?? 0) * 3,
    );
    expect(reports[2]?.analysisWork.totalNodeVisits).toBeLessThanOrEqual(
      (reports[1]?.analysisWork.totalNodeVisits ?? 0) * 3,
    );
  }, 30_000);
});
