# Core Policy, Scoring, and Readability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
> Follow TDD for every production behavior. Do not commit or push without a
> separate, current user authorization.

**Goal:** Deliver the first complete deterministic review foundation: strict
policy resolution, a configurable 100.0-point scoring engine, and
TypeScript/JavaScript readability analysis with CLI commands.

**Architecture:** Policy loading, score calculation, and language analysis are
pure core modules with explicit resource limits and no network or repository
side effects. Command modules translate CLI arguments into those typed APIs.
The existing `CQ-AGENT-001` validator remains one validation component and is
combined with policy diagnostics only at the command boundary.

**Tech Stack:** Node.js 22+, strict TypeScript ESM, Commander, Ajv draft
2020-12, YAML with source-aware errors, TypeScript compiler API, Vitest.

---

## File Map

- `schemas/*.schema.json`: stable machine contracts for rules, profiles,
  waivers, findings, score models, and run records.
- `rules/builtin/*.yaml`: built-in rule metadata with stable IDs and versions.
- `profiles/default.yaml`: the built-in profile and default budgets.
- `src/core/config.ts`: bounded YAML/JSON loading and path containment.
- `src/core/policy.ts`: schema validation and effective-policy resolution.
- `src/core/waivers.ts`: waiver validation, expiry, and applicability.
- `src/core/scoring.ts`: score-model validation and score calculation.
- `src/analysis/language-analyzer.ts`: language-neutral analysis contracts.
- `src/analysis/typescript-analyzer.ts`: compiler-API metrics and source ranges.
- `src/analysis/readability.ts`: deterministic signals and gate classification.
- `src/commands/rules.ts`: `rules list` and `rules explain`.
- `src/commands/score.ts`: score input parsing and reporting.
- `src/commands/inspect.ts`: focused readability inspection.
- `src/commands/validate.ts`: aggregate Agent and policy validation.
- `src/cli.ts`: Commander wiring only.

## Task 1: Strict Policy Contracts and Effective Policy

**Files:**

- Create: `schemas/rule.schema.json`
- Create: `schemas/profile.schema.json`
- Create: `schemas/waiver.schema.json`
- Create: `schemas/finding.schema.json`
- Create: `schemas/score-model.schema.json`
- Create: `schemas/run.schema.json`
- Create: `rules/builtin/universal.yaml`
- Create: `profiles/default.yaml`
- Create: `src/core/config.ts`
- Create: `src/core/policy.ts`
- Create: `src/core/waivers.ts`
- Create: `tests/unit/core/policy.test.ts`
- Create: `tests/unit/core/waivers.test.ts`

- [x] **Step 1: Write failing schema and precedence tests**

Cover valid built-ins, unknown keys, duplicate rule IDs, unsafe provider fields
in repository profiles, invalid budgets, missing references, precedence, stable
policy hashes, expired waivers, missing waiver accountability, and path/symbol
scope matching.

```typescript
const result = await resolveEffectivePolicy({ repository, now });
expect(result.policy.rules.map((rule) => rule.id)).toContain("CQ-READ-001");
expect(result.diagnostics).toEqual([]);
expect(result.policyHash).toMatch(/^[a-f0-9]{64}$/u);
```

- [x] **Step 2: Verify RED**

Run:

```bash
corepack pnpm exec vitest run tests/unit/core/policy.test.ts tests/unit/core/waivers.test.ts
```

Expected: FAIL because the policy and waiver modules do not exist.

- [x] **Step 3: Implement bounded structured loading and resolution**

Use Ajv draft 2020-12 with `additionalProperties: false`. YAML input is capped
at 1 MiB per file and 8 MiB per resolution. Repository policy may select only a
provider name; it cannot define endpoints, credential variables, or headers.
Resolution returns immutable values, source locations/hashes, diagnostics, and
a canonical SHA-256 policy hash. Invalid policy never falls back silently.

```typescript
export interface ResolvePolicyRequest {
  readonly repository: string;
  readonly profileName?: string;
  readonly now?: Date;
  readonly overrides?: Readonly<Record<string, unknown>>;
}

export interface EffectivePolicyResult {
  readonly policy?: EffectivePolicy;
  readonly policyHash?: string;
  readonly diagnostics: readonly PolicyDiagnostic[];
}
```

- [x] **Step 4: Verify GREEN**

Run the targeted tests, then `corepack pnpm typecheck` and
`corepack pnpm lint`.

## Task 2: Versioned 100.0-Point Scoring Engine

**Files:**

- Create: `src/core/scoring.ts`
- Create: `tests/unit/core/scoring.test.ts`

- [x] **Step 1: Write failing score-model tests**

Cover the eight default major dimensions and all named minor items, exact
100.0-point validation using integer tenths, profile weight overrides, ratings
from 0.0 to 5.0 in 0.5 increments, `not_applicable`, `not_assessed`, focused
domain output, one-decimal boundary rounding, baseline compatibility, and gate
independence.

```typescript
const result = calculateScore(DEFAULT_SCORE_MODEL, assessments, {
  scope: "repository",
  gate: "PASS",
});
expect(result.display.normalized).toBe("84.9");
expect(result.gate).toBe("PASS");
```

- [x] **Step 2: Verify RED**

```bash
corepack pnpm exec vitest run tests/unit/core/scoring.test.ts
```

Expected: FAIL because `src/core/scoring.ts` does not exist.

- [x] **Step 3: Implement exact model validation and calculation**

```typescript
export type Assessment = ScoredAssessment | NotApplicableAssessment |
  NotAssessedAssessment;

export function validateScoreModel(model: ScoreModel): readonly ScoreIssue[];
export function calculateScore(
  model: ScoreModel,
  assessments: readonly Assessment[],
  context: ScoreContext,
): ScoreResult;
```

Keep weights in tenths, retain full internal precision, and round only rendered
values. A required `not_assessed` item forces `INCOMPLETE`. Confirmed blocking
findings force `BLOCK` regardless of score.

- [x] **Step 4: Verify GREEN**

Run the targeted tests, typecheck, lint, and format check.

## Task 3: TypeScript/JavaScript Readability Analyzer

**Files:**

- Create: `src/analysis/language-analyzer.ts`
- Create: `src/analysis/typescript-analyzer.ts`
- Create: `src/analysis/readability.ts`
- Create: `tests/unit/analysis/typescript-analyzer.test.ts`
- Create: `tests/unit/analysis/readability.test.ts`
- Create: `tests/fixtures/readability/octopus-pattern.ts`

- [x] **Step 1: Write failing AST metric tests**

Tests must prove source ranges and metrics for function/file/try spans,
decisions, nesting, returns, awaits, local declarations, catches, nested
ternaries, semantic nullish chains, mixed conditional/fallback expressions,
large object literals, and distinct return-object shapes. Include false-positive
tests for `value ?? defaultValue` and ordinary single ternaries.

```typescript
const report = analyzeTypeScriptSource("example.ts", source);
expect(report.functions[0]).toMatchObject({
  name: "exportOrchestrator",
  nestedTernaryDepth: 2,
  maximumNullishChainValues: 3,
});
```

- [x] **Step 2: Verify RED**

```bash
corepack pnpm exec vitest run tests/unit/analysis
```

Expected: FAIL because the analysis modules do not exist.

- [x] **Step 3: Implement iterative compiler-API traversal**

```typescript
export interface LanguageAnalyzer {
  supports(path: string): boolean;
  analyze(input: SourceAnalysisInput): SourceAnalysisResult;
}

export function analyzeTypeScriptSource(
  path: string,
  source: string,
  limits?: AnalysisLimits,
): SourceAnalysisResult;
```

Reject files above 4 MiB or ASTs above 250,000 visited nodes with an explicit
incomplete diagnostic. Traverse iteratively so hostile nesting cannot overflow
the JavaScript stack. Do not execute or typecheck target code.

- [x] **Step 4: Implement readability signal classification**

Map deterministic evidence to `CQ-READ-001` through `CQ-READ-008` candidates.
Metrics alone remain candidates except hard gates for a new function above 300
lines or a new file above 1,000 lines. Baseline comparison classifies new,
expanded, improved, and unchanged hotspots.

- [x] **Step 5: Verify GREEN with the synthetic Octopus pattern**

The synthetic fixture must trigger giant-function, wide-try,
conditional/fallback, large-result-shape, and cognitive-distance evidence
without copying source or business names from OctopusMCPServer.

## Task 4: CLI Integration

**Files:**

- Create: `src/commands/rules.ts`
- Create: `src/commands/score.ts`
- Create: `src/commands/inspect.ts`
- Modify: `src/commands/validate.ts`
- Modify: `src/cli.ts`
- Create: `tests/integration/cli-policy-score-readability.test.ts`
- Modify: `README.md`
- Modify: `docs/standards/testing-and-automation.md`

- [x] **Step 1: Write failing command tests**

Cover `validate`, `rules list`, `rules explain`, `inspect readability`, and
`score`. No command may write target code, call a model, or hide incomplete
analysis. Terminal and JSON outputs must be deterministic and terminal-safe.

- [x] **Step 2: Verify RED**

```bash
corepack pnpm exec vitest run tests/integration/cli-policy-score-readability.test.ts
```

- [x] **Step 3: Add command wiring and reporters**

Command modules own argument validation only. `inspect readability` reports a
focused-domain subtotal. `score` rejects a full total when required domains are
not assessed. `validate` aggregates all deterministic validation diagnostics.

- [x] **Step 4: Verify GREEN and document current behavior**

Run targeted tests and then the complete repository quality suite.

## Task 5: Mandatory Review

- [x] Spec reviewer confirms every deterministic requirement and false-positive
  guard in this plan.
- [x] Code-quality reviewer checks type safety, readability, resource bounds,
  deterministic ordering, race/TOCTOU handling, and test credibility.
- [x] Controller runs fresh format, lint, typecheck, all tests, build,
  dependency audit, secret scan, CLI smoke tests, `git diff --check`, and a
  workspace-safety review.

