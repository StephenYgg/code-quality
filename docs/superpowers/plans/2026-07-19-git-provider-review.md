# Git Inputs, Providers, and Review Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
> Every behavior change follows TDD. Do not commit, push, publish, install a
> hook, or contact a real provider during the default test suite.

**Goal:** Normalize all seven review inputs into immutable snapshots and run a
bounded, model-backed review through Codex CLI, Claude CLI,
OpenAI-compatible, or Anthropic-compatible adapters.

**Architecture:** Git and forge resolvers produce one content-addressed
snapshot contract before provider work. Providers implement one typed,
schema-validated contract. A deterministic planner selects mandatory and
risk-triggered stages; the orchestrator limits concurrency and attempts,
deduplicates candidates, verifies findings, and returns a normalized run result
to pure reporters.

**Tech Stack:** Node.js child processes without a shell, Git, native `fetch`,
Ajv, SHA-256 manifests, Vitest fake executables/local HTTP servers.

---

## Task 1: Local Git Inputs and Immutable Snapshots

**Files:**

- Create: `src/git/commands.ts`
- Create: `src/git/repository.ts`
- Create: `src/git/inputs.ts`
- Create: `src/core/snapshots.ts`
- Create: `tests/unit/git/commands.test.ts`
- Create: `tests/integration/git-inputs.test.ts`

- [x] Write failing tests for worktree, staged, commit, and range selectors;
  selector mutual exclusion; invalid revisions; rename/binary metadata;
  deterministic ordering; worktree/index mutation; bounded stdout/stderr;
  timeout/cancellation; and repositories with unusual filenames.
- [x] Run `corepack pnpm exec vitest run tests/unit/git
  tests/integration/git-inputs.test.ts` and verify expected RED.
- [x] Implement `spawn`-based Git execution with argument arrays, no shell,
  sanitized environment, output caps, timeout, abort handling, and terminal-safe
  diagnostics.
- [x] Resolve each selector to the following immutable contract and verify the
  source identity after collection:

```typescript
export interface ReviewSnapshot {
  readonly inputKind: "worktree" | "staged" | "commit" | "range" |
    "repository" | "github_pr" | "gitlab_mr";
  readonly scope: "change" | "repository";
  readonly repository: string;
  readonly comparisonBase?: string;
  readonly head: string;
  readonly contentHash: string;
  readonly files: readonly SnapshotFile[];
  readonly diff?: string;
  readonly exclusions: readonly SnapshotExclusion[];
  readonly incomplete: boolean;
}
```

- [x] Verify GREEN, including deterministic snapshot hashes and stale-source
  rejection.

## Task 2: Full Repository Preflight and Manifest Confirmation

**Files:**

- Create: `src/git/repository-manifest.ts`
- Create: `tests/integration/repository-preflight.test.ts`

- [x] Write failing tests proving full-repository scope is never inferred,
  ignores `.git`, dependencies, generated output, caches, binaries, suspected
  secrets, and Git-ignored files; reports every exclusion category; includes
  tracked and eligible untracked source; and stops at hard file/byte limits.
- [x] Verify RED.
- [x] Build a content-addressed manifest with defaults of 5,000 files and
  50 MiB raw content, bounded entry/path/individual-file limits, stable POSIX
  ordering, descriptor/path identity checks, and no target code execution.
- [x] Preflight returns repository identity, counts, exclusions, provider and
  endpoint class, egress class, budgets, truncation, and manifest hash without
  calling a provider.
- [x] Provider execution requires either an interactive confirmation bound to
  that hash or `--confirm-full-repository <hash>`; generic `--yes`, publication
  confirmation, stale hashes, and changed manifests are rejected.
- [x] Verify GREEN and race/TOCTOU tests.

## Task 3: Provider Contract and Four Adapters

**Files:**

- Create: `src/providers/provider.ts`
- Create: `src/providers/process-provider.ts`
- Create: `src/providers/codex-cli.ts`
- Create: `src/providers/claude-cli.ts`
- Create: `src/providers/http.ts`
- Create: `src/providers/openai-compatible.ts`
- Create: `src/providers/anthropic-compatible.ts`
- Create: `tests/fixtures/providers/fake-cli.mjs`
- Create: `tests/unit/providers/*.test.ts`

- [x] Write failing contract tests for capabilities, configuration validation,
  successful structured review, invalid JSON, one bounded repair attempt,
  timeout, cancellation, stderr/body/header redaction, maximum response size,
  usage, finish reason, request ID, and truncation.
- [x] Verify RED using fake executables and local HTTP servers only.
- [x] Implement the shared contract:

```typescript
export interface ReviewProvider {
  capabilities(): ProviderCapabilities;
  validateConfiguration(): Promise<readonly ProviderDiagnostic[]>;
  review(request: ProviderReviewRequest): Promise<ProviderReviewResponse>;
  redactDiagnostic(value: unknown): string;
}
```

- [x] Codex and Claude run directly with argument arrays, stdin request,
  isolated temporary cwd, no shell, minimal environment, no-tools/read-only
  flags, bounded stdout/stderr, abort termination, and version/capability
  refusal if safe mode cannot be enforced.
- [x] HTTP adapters require HTTPS except explicit loopback development,
  reject cross-origin redirects, source credentials only from trusted user
  configuration, cap request/response/diagnostics, and never expose secret
  values or credential-routing metadata.
- [x] Verify GREEN and run provider tests repeatedly to check stability.

## Task 4: Findings, Risk Routing, and Review Orchestration

**Files:**

- Create: `src/core/findings.ts`
- Create: `src/core/risk-router.ts`
- Create: `src/review/planner.ts`
- Create: `src/review/context.ts`
- Create: `src/review/prompts.ts`
- Create: `src/review/stages.ts`
- Create: `src/review/verifier.ts`
- Create: `src/review/orchestrator.ts`
- Create: `tests/unit/review/*.test.ts`

- [x] Write failing tests for legal finding transitions, mandatory universal/
  behavior/readability/testing/concurrency stages, additive risk triggers,
  maximum seven stages, maximum two in-flight provider requests, maximum
  sixteen attempts including repair, bounded context, cancellation, prompt
  injection delimiting, candidate dedupe, contradictions, verification,
  disposition against comparison base, and gate decisions.
- [x] Verify RED.
- [x] Implement a deterministic planner that models cannot use to remove
  mandatory stages. Repository content and change metadata are delimited
  untrusted data.
- [x] Implement bounded orchestration. Candidates cannot become blocking
  findings until code/contract evidence verifies them. Contradictory outcomes
  remain `uncertain`; duplicate root causes preserve all stages and the most
  precise evidence.
- [x] Verify GREEN with deterministic fake providers and controlled interleaving.

## Task 5: Run Records and Pure Reports

**Files:**

- Create: `src/storage/runs.ts`
- Create: `src/reporters/json.ts`
- Create: `src/reporters/markdown.ts`
- Create: `src/reporters/terminal.ts`
- Create: `src/commands/review.ts`
- Create: `src/commands/report.ts`
- Create: `src/commands/runs.ts`
- Create: `tests/unit/storage/runs.test.ts`
- Create: `tests/unit/reporters/review-reporters.test.ts`
- Create: `tests/integration/cli-review.test.ts`

- [x] Write failing tests for atomic run writes, bounded retention, permission
  mode, no raw prompt/source/response retention by default, sensitive transcript
  opt-in, stable JSON, ordered findings, uncertain/waived sections, verification,
  concurrency review, score, coverage, exclusions, incomplete state, and all
  exit codes.
- [x] Verify RED.
- [x] Implement XDG/platform state storage using temporary-file plus fsync/
  atomic rename, content hashes, bounded records, and no repository-local state
  unless explicitly selected.
- [x] Add `cq review`, `cq report`, and `cq runs` wiring. `--output` is the only
  ordinary report write and must use exclusive or atomic replacement semantics.
- [x] Verify GREEN and run the end-to-end fake-provider review.

## Task 6: Review and Verification

- [x] Spec reviewer checks all seven normalized inputs, provider contracts,
  authorization boundaries, prompt injection treatment, finding verification,
  and exit semantics.
- [x] Code-quality reviewer checks process/network cleanup, resource limits,
  deterministic ordering, TOCTOU, secret redaction, concurrency bounds, and
  test credibility.
- [x] Controller runs full format, lint, typecheck, unit/integration tests,
  build, dependency audit, secret scan, repeat-run stability, CLI smoke tests,
  and workspace diff review.

