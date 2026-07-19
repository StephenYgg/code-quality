# Forge, Integrations, Hooks, and Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
> Skill artifacts additionally require `superpowers:writing-skills` and the
> platform skill-creator guidance. Use TDD. Do not commit, push, publish a
> review, install integrations, or install hooks without an explicit command
> and the required confirmation.

**Goal:** Complete forge review/publication, bounded shared runtime state,
managed Agent integrations and Skills, optional Git hooks, inactive CI assets,
benchmarking, and release-quality local checks.

**Architecture:** Forge read and publication adapters are separated so read
tokens do not imply write authority. Cache and lock state is content-addressed
and process-shared on one machine. Integrations and hooks use previewable,
recognized managed blocks with atomic writes. Skills and templates route to the
CLI and canonical standards without copying machine policy.

**Tech Stack:** Node.js 22+, native `fetch`, GitHub/GitLab REST APIs, atomic
filesystem operations, POSIX hooks, Markdown Skill files, inactive YAML
templates, Vitest.

---

## Task 1: GitHub and GitLab Read Adapters

**Files:**

- Create: `src/forges/forge.ts`
- Create: `src/forges/url.ts`
- Create: `src/forges/github.ts`
- Create: `src/forges/gitlab.ts`
- Create: `tests/unit/forges/url.test.ts`
- Create: `tests/unit/forges/github.test.ts`
- Create: `tests/unit/forges/gitlab.test.ts`

- [x] Write failing tests for canonical GitHub PR and GitLab MR URLs,
  percent-encoded GitLab projects, rejected userinfo/ports/fragments, public
  unauthenticated reads, trusted-host token lookup, base/head/commit/file
  metadata, pagination, limits, stale head, redirects, redaction, and enterprise
  hosts requiring trusted mappings.
- [x] Verify RED using local HTTP servers and injected transports.
- [x] Implement a read-only forge contract. URL content cannot select an
  environment variable, token, provider, endpoint, active policy, instruction,
  or executable command. Credentials never enter Git remote URLs.
- [x] Normalize PR/MR data into the same immutable snapshot contract as local
  Git inputs and verify current head before result reuse.
- [x] Verify GREEN.

## Task 2: Single-Flight Cache, Locks, and Retention

**Files:**

- Create: `src/storage/paths.ts`
- Create: `src/storage/cache.ts`
- Create: `src/storage/locks.ts`
- Create: `tests/unit/storage/cache.test.ts`
- Create: `tests/unit/storage/locks.test.ts`

- [x] Write failing controlled-interleaving tests for one atomic lock winner,
  bounded loser waiting, renewable lease, owner-token release, expired-owner
  safety, atomic cache publish, corrupt entry rejection, LRU/age/size cleanup,
  cancellation, and multiple processes sharing one state directory.
- [x] Verify RED.
- [x] Implement locks scoped only to the full content-addressed review key.
  There is no global repository/account lock. The winner renews a bounded lease;
  losers wait within a fixed budget then reuse a complete result or return
  incomplete. Release and renewal compare owner tokens.
- [x] Cache only sanitized normalized results by default. Bound entries, bytes,
  retention, cleanup work per invocation, and waiters.
- [x] Verify GREEN and resource estimates.

## Task 3: Idempotent Optional Publication

**Files:**

- Create: `src/forges/publish.ts`
- Create: `tests/unit/forges/publish.test.ts`
- Modify: `src/commands/review.ts`

- [x] Write failing tests for independent publication authorization,
  interactive preview fields, non-interactive `--publish --yes`, stale-head
  refusal, read-only token refusal, report-hash marker lookup, create/update/
  reuse behavior, retry after ambiguous failure, cancellation, and exit code 4.
- [x] Verify RED.
- [x] Use identity `forge + repository + change number + head SHA + report
  hash` and a stable hidden marker. Re-fetch metadata immediately before
  publication. A retry cannot create duplicate comments; publication logs store
  target/result IDs but never credentials.
- [x] Verify GREEN. Default tests must not contact external hosts.

## Task 4: Initialization and Managed Agent Integrations

**Files:**

- Create: `src/commands/init.ts`
- Create: `src/instructions/integrations.ts`
- Create: `src/commands/integrations.ts`
- Create: `templates/agents/AGENTS.snippet.md`
- Create: `templates/agents/CLAUDE.snippet.md`
- Create: `skills/code-quality-review/SKILL.md`
- Create: `skills/code-quality-review/references/codex.md`
- Create: `skills/code-quality-review/references/claude-code.md`
- Create: `tests/unit/instructions/integrations.test.ts`
- Create: `tests/integration/cli-integrations.test.ts`

- [x] Write failing tests for read-only plans, exact affected paths/diffs,
  confirmation, recognized managed-block install/update/remove, unrelated text
  preservation, existing project policy refusal, symlink/path traversal,
  concurrent file mutation, atomic writes, permission preservation, status, and
  rollback after partial failure.
- [x] Verify RED.
- [x] `cq init` previews `.code-quality/profile.yaml`, requires confirmation,
  creates no replacement `AGENTS.md`, and refuses existing profile overwrite.
- [x] Integrations target Codex global `AGENTS.md`/Skill and Claude global
  `CLAUDE.md`/Skill or repository-scoped equivalents. Shared logic remains in
  `AGENTS.md`; peer files contain only pointers and tool-specific deltas.
- [x] Skills explain triggers, CLI exit states, analysis-versus-modification,
  full-repository confirmation, and publication confirmation while referencing
  rules rather than duplicating them.
- [x] Verify GREEN and validate the Skill with its prescribed validator.

## Task 5: Optional Git Hooks

**Files:**

- Create: `src/commands/hooks.ts`
- Create: `src/hooks/manager.ts`
- Create: `templates/hooks/pre-commit`
- Create: `templates/hooks/pre-push`
- Create: `tests/integration/hooks.test.ts`

- [x] Write failing temporary-repository tests for `core.hooksPath`, absent
  hooks, recognized managed hooks, unknown hook refusal/chaining snippet,
  install/status/uninstall, warn/block/strict presets, staged snapshot cache,
  provider unavailable fail-open warning, gate failure exit, and concurrent
  install/mutation.
- [x] Verify RED.
- [x] Install only after explicit CLI command and confirmation. Write atomic,
  executable managed hooks. Warn never blocks; block maps the CLI gate. Local
  hooks remain bypassable and are never described as server enforcement.
- [x] Verify GREEN without modifying this repository's actual hooks.

## Task 6: Benchmark Corpus and Evaluation

**Files:**

- Create: `src/benchmark/evaluate.ts`
- Create: `benchmarks/manifest.yaml`
- Create: `benchmarks/readability/*.ts`
- Create: `benchmarks/security/*.txt`
- Create: `tests/unit/benchmark/evaluate.test.ts`

- [x] Write failing tests for exact/partial/missed/false-positive/duplicate/
  unstable classification; precision/recall/FPR/duplicate/stability metrics;
  high-severity miss breakout; provider/model/prompt/rule versions; and bounded
  repeat runs.
- [x] Verify RED.
- [x] Add human-labeled synthetic defects and clean counterexamples, including
  Octopus structural patterns and prompt-injection inputs, without copying
  proprietary source.
- [x] Verify GREEN and produce deterministic model-free baseline metrics.

## Task 7: Inactive CI, Local Security Checks, and Release Workflow

**Files:**

- Create: `scripts/check-dependencies.mjs`
- Create: `scripts/check-secrets.mjs`
- Create: `templates/ci/github-actions.yml`
- Create: `templates/ci/gitlab-ci.yml`
- Create: `templates/ci/README.md`
- Create: `docs/playbooks/release.md`
- Modify: `package.json`
- Modify: `README.md`

- [x] Write failing tests/fixtures for secret pattern/path/history scanning,
  redacted diagnostics, bounded file sizes/counts, allowlist accountability,
  production dependency audit failures, and inactive template location.
- [x] Verify RED.
- [x] Add `check:dependencies` and `check:secrets` to `pnpm check`. Templates
  remain outside `.github/workflows`, use least privilege, immutable action
  revisions, no production credentials, documented check names, caching, and
  branch-protection setup.
- [x] Document package packing/global installation smoke tests and provenance
  as future registry operations; do not publish a package.
- [x] Verify package contents with `pnpm pack --dry-run` or the supported pnpm
  equivalent, then execute a temporary global/link-style CLI smoke test.

## Task 8: Final Acceptance Review

- [x] Run every first-release acceptance criterion from the approved design.
- [x] Spec review confirms all seven inputs, four providers, two forges,
  immutable snapshots, effective policy, scoring, readability, Skills, hooks,
  inactive CI, publication confirmation, and `CQ-AGENT-001` behavior.
- [x] Code-quality review checks files/functions against readability thresholds,
  external side effects, trust boundaries, descriptor/path TOCTOU, single-flight,
  queue/request/token/time/storage bounds, cleanup, and multi-instance claims.
- [x] Run fresh format, lint, typecheck, all tests, build, dependency check,
  secret check, package smoke tests, CLI help/validation/readability/review
  smoke tests, `git diff --check`, and verify no unrelated workspace changes.

