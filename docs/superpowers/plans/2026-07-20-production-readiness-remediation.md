# Production Readiness Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan task by task.
> Every production behavior change follows Red-Green-Refactor. Do not commit,
> push, publish, install hooks, or call real providers/forges without explicit
> user authorization.

**Goal:** Raise the reproducible first-release acceptance result from 60.5% to
at least 95% by closing confirmed correctness, security, concurrency, resource,
readability, and delivery gaps.

**Architecture:** Review input resolvers produce an immutable content bundle
that is consumed unchanged by context, cache, verification, and reporting.
Provider output is schema-validated before evidence verification; scoring uses
explicit assessed evidence rather than absence of findings. Local single-flight
uses an atomic directory lock and bounded cache; cross-machine coordination is
not claimed without a real fencing service. CLI orchestration is split by input
kind so authorization and cleanup are visible.

**Tech Stack:** Node.js 22+, strict TypeScript, Git child processes without a
shell, Ajv, SHA-256 manifests, Vitest with controlled interleaving, temporary
Git repositories, fake process providers, and local HTTP servers.

---

## Acceptance Accounting

The release percentage is calculated from the 19 criteria in the approved
design:

```text
percentage = (complete + 0.5 * partial) / 19 * 100
```

At least 18 criteria must be complete and no criterion may fail. Any open P0 or
P1 keeps the release Gate at BLOCK regardless of percentage.

## Task 1: Immutable Review Content

**Files:**

- Create: `src/core/review-input.ts`
- Create: `src/git/content-capture.ts`
- Modify: `src/git/inputs.ts`
- Modify: `src/git/repository-manifest.ts`
- Modify: `src/forges/materialize.ts`
- Modify: `src/review/context.ts`
- Modify: `src/commands/review.ts`
- Test: `tests/integration/git-inputs.test.ts`
- Test: `tests/integration/forge-materialize.test.ts`
- Test: `tests/unit/review/context.test.ts`

- [ ] Add failing tests proving staged content differs from unstaged worktree,
  old commit/range content differs from current HEAD, capture-after-replacement
  is rejected, and Forge context reads the materialized head bytes.
- [ ] Verify RED with
  `corepack pnpm exec vitest run tests/integration/git-inputs.test.ts tests/integration/forge-materialize.test.ts tests/unit/review/context.test.ts`.
- [ ] Add `ImmutableReviewInput` containing `snapshot` and a private,
  non-serializable `ReadonlyMap<string, Buffer>` content bundle.
- [ ] Read commit/range bytes from Git objects, staged bytes from the captured
  index, and worktree/untracked bytes through descriptor/path identity checks.
- [ ] Make `collectReviewContext` accept only captured bytes; remove pathname
  fallback from production review paths.
- [ ] Recheck source/index identity after content capture and bind a content
  bundle hash into the review/cache identity.
- [ ] Verify GREEN, repeat the mutation tests 20 times, then run lint/typecheck.

## Task 2: Provider Output Validation and Evidence Verification

**Files:**

- Create: `src/review/stage-output.ts`
- Create: `src/review/evidence-verifier.ts`
- Modify: `src/review/prompts.ts`
- Modify: `src/review/orchestrator.ts`
- Modify: `src/review/verifier.ts`
- Modify: `src/core/findings.ts`
- Test: `tests/unit/review/stage-output.test.ts`
- Test: `tests/unit/review/verifier.test.ts`
- Test: `tests/unit/review/orchestrator.test.ts`

- [ ] Add failing tests for `{}`, unknown severity, unknown keys, missing
  evidence locations, fabricated path mentions, contradictory candidates, and
  evidence outside captured source ranges.
- [ ] Verify RED. The current `{}` response must reproduce PASS before the fix.
- [ ] Compile `STAGE_OUTPUT_SCHEMA` with Ajv once and reject invalid content as
  `PROVIDER_RESPONSE_INVALID`; invalid output may consume one bounded repair
  attempt and otherwise marks the run INCOMPLETE.
- [ ] Require blocking evidence to identify a captured path, bounded line
  range, quoted source/contract fact, and a verifier-supported match in the
  immutable content or diff. A filename mention alone remains `uncertain`.
- [ ] Preserve contradictions as `uncertain`; do not silently discard provider
  validation diagnostics.
- [ ] Verify GREEN and prove the former fabricated P1 is no longer confirmed.

## Task 3: Evidence-Backed Review Scoring

**Files:**

- Modify: `src/review/prompts.ts`
- Modify: `src/review/score-bridge.ts`
- Modify: `src/review/orchestrator.ts`
- Modify: `src/commands/review.ts`
- Test: `tests/unit/review/score-bridge.test.ts`
- Test: `tests/integration/cli-review.test.ts`

- [ ] Add failing tests proving an unrouted security domain is
  `not_assessed`, `{ candidates: [] }` is not positive score evidence, profile
  score-model overrides apply, and `--score` cannot display 100% coverage
  without every required assessment.
- [ ] Verify RED against the current 90.0/100% fabricated result.
- [ ] Extend validated stage output with bounded, model-versioned assessment
  evidence for only the minor IDs owned by that stage.
- [ ] Merge explicit assessments deterministically. Missing evidence remains
  `not_assessed`; justified exclusions use `not_applicable` with a reason.
- [ ] Compute the complete model only for `--score`/repository score workflows;
  ordinary reviews retain Gate and domain coverage without inventing a total.
- [ ] Verify GREEN for all 37+ configured minor items, one-decimal output, and
  independent BLOCK/INCOMPLETE gate semantics.

## Task 4: Full-Repository Confirmation Contract

**Files:**

- Create: `src/review/execution-descriptor.ts`
- Modify: `src/review/policy-binding.ts`
- Modify: `src/git/repository-manifest.ts`
- Modify: `src/commands/review.ts`
- Test: `tests/integration/repository-preflight.test.ts`
- Test: `tests/integration/cli-review.test.ts`

- [ ] Add an end-to-end failing test: preflight with a selected injected
  provider, reuse the displayed hash, and assert provider execution succeeds.
- [ ] Add mismatch tests for provider, model, policy, egress, token/time/cost
  budgets, limits, and file content. Preflight must make zero review calls.
- [ ] Build one canonical execution descriptor before both preflight and
  execution. It contains effective policy hash, provider/endpoint/egress class,
  model, limits, and budgets.
- [ ] Require provider metadata and valid policy for execution-bound preflight;
  never use zero hashes or zero budgets as silent fallbacks.
- [ ] Preserve a separate manifest-only diagnostic mode only if it is clearly
  non-confirmable.
- [ ] Verify GREEN and CLI exit codes 0/2/3.

## Task 5: Correct Local Single-Flight and Bounded Storage

**Files:**

- Modify: `src/storage/locks.ts`
- Modify: `src/storage/cache.ts`
- Modify: `src/storage/runs.ts`
- Modify: `src/review/single-flight.ts`
- Modify: `src/storage/paths.ts`
- Test: `tests/unit/storage/locks.test.ts`
- Test: `tests/unit/storage/cache.test.ts`
- Test: `tests/unit/review/single-flight.test.ts`

- [ ] Add controlled-interleaving tests for 32 simultaneous expired-lock
  contenders, owner death, old-owner release, a run longer than the lease,
  loser cancellation, and corrupt cache entries.
- [ ] Verify RED; the current implementation must demonstrate multiple winners.
- [ ] Replace file rename reclamation with atomic lock-directory acquisition.
  On the local host, a live owner PID is never reclaimed; dead owners may be
  quarantined before a new atomic acquire. Do not claim cross-machine CAS.
- [ ] Make loser waits cancellable, jittered, and bounded. Safety wins over
  reclaim liveness for unknown remote owners.
- [ ] Validate cached records against the run schema and content key before
  reuse.
- [ ] Add hard max entries, bytes, and age plus bounded cleanup work per call;
  remove the unsupported shared-fencing claim from docs/status.
- [ ] Order run retention by timestamps, limit cleanup work, and keep writes
  permission-restricted and atomic.
- [ ] Verify one provider winner across repeated process-level tests and report
  the resource estimate.

## Task 6: Forge Trust, Private Reads, and Idempotent Publication

**Files:**

- Modify: `src/forges/forge.ts`
- Modify: `src/forges/github.ts`
- Modify: `src/forges/gitlab.ts`
- Modify: `src/forges/materialize.ts`
- Modify: `src/forges/publish.ts`
- Modify: `src/review/base-policy.ts`
- Split: `src/commands/review.ts` into `src/commands/review-forge.ts`
- Test: `tests/unit/forges/github.test.ts`
- Test: `tests/unit/forges/gitlab.test.ts`
- Test: `tests/unit/forges/publish.test.ts`
- Test: `tests/integration/forge-materialize.test.ts`

- [ ] Add failing tests for private initial/fresh reads, exact trusted hosts,
  fork changes, token absence from argv and bare config, base-policy Provider
  selection, materialization failure, sequential retry, ambiguous failure, and
  concurrent publication.
- [ ] Verify RED, including a clone-config assertion that the token is absent.
- [ ] Resolve trusted forge credentials/host mapping outside the repository and
  pass them to every API read.
- [ ] Pass Git HTTP authorization through a non-persistent environment/config
  mechanism; never place secret values in argv, remotes, cache, or config.
- [ ] Materialize and bind base policy before selecting Provider/model. Fail
  closed when an authoritative base cannot be obtained for a publishable run.
- [ ] Page through bounded existing comments, find the exact marker, and
  reconcile create/update/reuse. Add a forge-side idempotency strategy for
  concurrent publishers.
- [ ] Put materialized worktree cleanup in one `finally` covering review,
  storage, rendering, and publication.
- [ ] Verify GREEN without contacting external hosts.

## Task 7: Real Provider Contracts and Bounded Processes/HTTP

**Files:**

- Create: `src/providers/bounded-response.ts`
- Modify: `src/providers/process-provider.ts`
- Modify: `src/providers/codex-cli.ts`
- Modify: `src/providers/claude-cli.ts`
- Modify: `src/providers/http.ts`
- Modify: `src/providers/probe.ts`
- Modify: `src/providers/live-soak.ts`
- Modify: `tests/fixtures/providers/fake-cli.mjs`
- Test: `tests/unit/providers/providers.test.ts`
- Test: `tests/unit/providers/probe.test.ts`

- [ ] Add failing fixtures matching real Codex JSONL events and Claude JSON
  envelopes; assert Claude receives a schema JSON string and Codex reads the
  final structured response rather than `turn.completed`.
- [ ] Add oversized streaming, SIGTERM-resistant process, cancellation, spawn
  failure, malformed schema output, and repair-prompt tests.
- [ ] Verify RED.
- [ ] Use Codex `--output-last-message` with a bounded 0600 output file; parse
  JSONL only for usage/request metadata.
- [ ] Pass Claude `--json-schema` a bounded JSON string and probe every required
  runtime flag.
- [ ] Stream HTTP bodies with a byte cap and cancel the reader on overflow.
  A repair request explicitly includes the validation failure and schema-only
  instruction within the global attempt budget.
- [ ] Cache safe-mode validation per resolved executable/version for one run;
  do not spawn a help probe per stage.
- [ ] Make live soak verify the expected synthetic response; label HTTP config
  validation as non-live unless it sends the bounded request.
- [ ] Verify GREEN with fake processes and local HTTP only.

## Task 8: Hooks, Run-Checks, and Readable CLI Boundaries

**Files:**

- Split: `src/cli.ts` into command registration modules under `src/cli/`
- Split: `src/commands/review.ts` into local/repository/forge/render modules
- Modify: `src/review/planner.ts`
- Modify: `src/review/run-checks.ts`
- Modify: `src/hooks/manager.ts`
- Modify: `src/hooks/run.ts`
- Test: `tests/unit/review/run-checks.test.ts`
- Test: `tests/integration/hooks.test.ts`
- Test: `tests/integration/cli-review.test.ts`

- [ ] Add failing tests for one fast provider pass, total wall-clock deadline,
  SIGTERM-resistant checks, spawn error, output cap termination, profile/base
  commands, staged bytes, `core.hooksPath`, managed-block preservation,
  concurrent install, rollback, and uninstall preservation.
- [ ] Verify RED.
- [ ] Make fast review one bounded general-risk stage that covers the five
  mandatory questions; reserve specialist fan-out for full review.
- [ ] Give run-checks a total deadline, cancellation, SIGKILL fallback, hard
  output termination, trusted executable resolution, and base-policy commands.
- [ ] Resolve the effective hook directory, edit only recognized managed blocks,
  stage both hook writes, and atomically apply/rollback without touching
  unrelated content.
- [ ] Keep command handlers under 150 lines and files near 600 lines; each
  module owns one selector or one external side-effect boundary.
- [ ] Run the project's readability analyzer on every changed production file;
  no new hard gate or expanded hotspot is accepted.

## Task 9: Benchmark, Coverage, Secret Scan, CI, and Progress Truth

**Files:**

- Modify: `src/benchmark/evaluate.ts`
- Modify: `benchmarks/manifest.yaml`
- Add: clean and adversarial benchmark fixtures
- Modify: `scripts/check-secrets.mjs`
- Create: `config/secret-scan-allowlist.json`
- Modify: `package.json`
- Modify: `templates/ci/github-actions.yml`
- Modify: `templates/ci/gitlab-ci.yml`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/PROGRESS.md`
- Modify: `docs/standards/testing-and-automation.md`
- Modify: `docs/standards/concurrency.md`

- [ ] Add failing tests for fixture existence, duplicate/stability/high-severity
  miss metrics, version metadata, secrets in tests/templates, oversized files,
  scan truncation, allowlist ownership/expiry, and immutable CI references.
- [ ] Verify RED.
- [ ] Add a runnable benchmark command that creates observations and records
  precision, recall, FPR, duplicate rate, repeat stability, high-severity misses,
  latency/tokens, and provider/model/prompt/rule versions.
- [ ] Scan all tracked release content. A skipped file/count/byte limit produces
  INCOMPLETE/failure, not `ok`; explicit synthetic fixtures use a reviewed,
  expiring allowlist.
- [ ] Add Vitest coverage tooling, scripts, changed-code ratchet documentation,
  and include dependency/secret/diff checks in the release command without
  hiding offline audit failures.
- [ ] Pin CI actions/images to immutable revisions.
- [ ] Replace subjective progress prose with the 19-row acceptance matrix and
  generated counts. Keep README, AGENTS, standards, and progress synchronized.
- [ ] Verify package contents, temporary install, both bin names, inactive CI,
  and no untracked release artifact.

## Task 10: Final Acceptance and Independent Review

- [ ] Run all 19 criteria and calculate the percentage from recorded statuses.
- [ ] Require at least 18 complete, no failed criteria, and no open P0/P1.
- [ ] Run fresh format, lint, typecheck, unit/integration/concurrency tests,
  coverage, build, dependency audit, secret scan, benchmark, pack/install smoke,
  CLI smoke, repeated race tests, and `git diff --check`.
- [ ] Run deterministic readability against every changed production file and
  document justified remaining historical hotspots.
- [ ] Complete the seven-part concurrency review with numeric resource bounds.
- [ ] Obtain independent spec-compliance review, then independent code-quality
  review; fix and re-review every blocking finding.
- [ ] Update `docs/PROGRESS.md` only from fresh evidence. Do not call the release
  95% complete merely because modules or tests exist.
