# Code Quality CLI Design

Status: Approved design; first `cq validate` / `CQ-AGENT-001` slice implemented

Date: 2026-07-19

## 1. Purpose

This project will become a long-lived, incremental code review quality system.
Its first executable release will provide a TypeScript CLI that can review local
Git changes and GitHub or GitLab changes with Codex, Claude, or compatible HTTP
providers. The CLI turns review expectations into repeatable behavior while
keeping human-readable standards, Agent instructions, and machine-enforced
policy synchronized.

The system has five integration layers with distinct ownership:

1. Global or repository Agent instructions define triggers and authorization
   boundaries and route to canonical standards.
2. Codex and Claude Code Skills teach a host Agent how to invoke and interpret
   the CLI without duplicating policy.
3. The Agent-neutral CLI owns executable policy resolution, review,
   validation, reporting, caching, and optional publication.
4. A target repository profile selects trusted rules, commands, budgets, and
   provider names within non-removable bounds.
5. Optional Git Hooks call the same CLI as a commit/push fallback; they own no
   separate review policy.

## 2. Goals

The first release must:

- Review worktree changes, staged changes, a commit, a commit range, a full
  repository, a GitHub pull request, or a GitLab merge request.
- Invoke local Codex and Claude CLIs.
- Invoke OpenAI-compatible Chat Completions endpoints and
  Anthropic-compatible Messages endpoints.
- Resolve machine-readable rules, repository profiles, and waivers into an
  auditable effective policy.
- Route changes through mandatory and risk-specific review stages.
- Keep candidate concerns separate from verified findings.
- Produce terminal, Markdown, and JSON reports.
- Optionally publish a verified report to GitHub or GitLab after explicit
  confirmation.
- Support fast pre-commit warnings and full pre-push reviews, with an optional
  strict pre-commit mode.
- Generate reusable Codex and Claude Code Skills plus optional user-level and
  target-repository adoption snippets. These integrations route to the CLI and
  do not duplicate machine policy.
- Validate same-directory Agent instruction reuse as `CQ-AGENT-001`: peer
  instruction files must route shared rules through `AGENTS.md`, retain only
  tool-specific deltas, and avoid copied, conflicting, or cyclic policy.
- Provide inactive CI templates and setup documentation without enabling a
  workflow in this repository.
- Keep provider credentials, endpoint trust, and forge credentials outside
  reviewed repositories so a change cannot redirect secrets.
- Treat human readability and future changeability as first-release quality
  gates, with deterministic TypeScript/JavaScript AST evidence and semantic
  review rather than raw line-count or operator-count bans.
- Produce an evidence-backed 100-point score with configurable major and minor
  weights, one-decimal precision, and a separate non-overridable gate result.

## 3. Non-goals

The first release will not:

- Run a daemon, server, web interface, or persistent background queue.
- Load third-party runtime plugins.
- Modify production code or generate fixes automatically.
- Commit, push, open pull requests, or publish review comments by default.
- Make local Git hooks impossible to bypass. Server-side required checks are
  needed for non-bypassable enforcement.
- Guarantee complete Windows support for Git hooks or local provider CLIs.
- Treat one model response as sufficient evidence for a blocking defect.
- Ban ordinary, locally clear uses of ternary expressions, optional chaining,
  or nullish coalescing.
- Enable files under `.github/workflows/` or modify GitLab project settings.

## 4. Approaches Considered

### 4.1 Modular core with built-in adapters

This is the selected approach. Policy, review orchestration, providers, forges,
reporters, and storage use internal interfaces. The first release ships only
built-in adapters. It provides clear boundaries without taking on plugin
protocol compatibility and supply-chain risk.

### 4.2 Single command implementation

A single module would be faster to start but would couple provider behavior,
forge behavior, rule resolution, and reporting. It would make contract testing
and future provider additions expensive. This approach is rejected.

### 4.3 Dynamic plugin platform

A dynamic plugin platform offers maximum extensibility but requires a plugin
manifest, compatibility policy, trust model, process isolation, and dependency
governance. It is deferred until real external adapter demand exists.

## 5. Technical Baseline

- Runtime: Node.js 22 LTS or newer compatible LTS release.
- Language: TypeScript with strict type checking.
- Module format: ESM.
- Package manager: pnpm.
- CLI parsing: Commander.
- Schema validation: Ajv with JSON Schema draft 2020-12.
- YAML parsing: a parser that preserves source locations for diagnostics.
- Testing: Vitest.
- Supported operating systems: macOS and Linux.
- Windows: Node-level behavior is kept portable, but Git hooks and provider CLI
  behavior are not release blockers.

The package exposes `code-quality` and `cq` binaries backed by the same entry
point.

## 6. Architecture

```text
CLI commands
  init | validate | review | report | rules | runs | hooks | integrations
                    |
Policy Engine ------+------ Input Resolver
rules/profile/waiver        worktree/staged/commit/range/repository/PR/MR
                    |
Review Planner
deterministic risk triggers + additive specialist stages
                    |
Review Orchestrator
context -> specialists -> dedupe -> conflict check -> verify
                    |
Provider Adapters
Codex CLI | Claude CLI | OpenAI-compatible | Anthropic-compatible
                    |
Reporters / Publishers
Terminal | Markdown | JSON | GitHub | GitLab
```

### 6.1 Source layout

```text
src/
  cli.ts
  commands/
    hooks.ts
    init.ts
    integrations.ts
    report.ts
    review.ts
    rules.ts
    runs.ts
    validate.ts
  core/
    errors.ts
    findings.ts
    policy.ts
    risk-router.ts
    snapshots.ts
    scoring.ts
    types.ts
    waivers.ts
  analysis/
    language-analyzer.ts
    readability.ts
    typescript-analyzer.ts
  instructions/
    discovery.ts
    integrations.ts
    reuse-validator.ts
  git/
    commands.ts
    inputs.ts
    repository.ts
  review/
    context.ts
    orchestrator.ts
    planner.ts
    prompts.ts
    stages.ts
    verifier.ts
  providers/
    anthropic-compatible.ts
    claude-cli.ts
    codex-cli.ts
    openai-compatible.ts
    provider.ts
  forges/
    forge.ts
    github.ts
    gitlab.ts
    publish.ts
  reporters/
    json.ts
    markdown.ts
    terminal.ts
  storage/
    cache.ts
    locks.ts
    runs.ts
schemas/
rules/
profiles/
skills/code-quality-review/
templates/
  agents/
  ci/
docs/
  standards/
  playbooks/
tests/
  fixtures/
  integration/
  unit/
```

Command modules translate CLI arguments into typed requests. They contain no
review policy or provider-specific behavior.

## 7. CLI Surface

### 7.1 Initialization and validation

```text
cq init [repository]
cq validate [repository]
cq rules list [--profile <name>]
cq rules explain <rule-id> [--profile <name>]
cq inspect readability <input>
cq score <input>
cq score --repository [path]
cq integrations plan --target codex|claude|all --scope user|repository
cq integrations install --target codex|claude|all --scope user|repository
cq integrations status
cq integrations uninstall --target codex|claude|all --scope user|repository
```

`cq init` creates `.code-quality/profile.yaml` only after confirmation. It also
prints or writes an optional target-repository `AGENTS.md` adoption snippet. It
never replaces an existing `AGENTS.md`.

`cq validate` validates schemas, references, rule IDs, waiver expiry, profile
overrides, provider configuration, and discovered instruction sources without
calling a model. Its built-in `CQ-AGENT-001` check walks instruction scopes,
grouping every discovered canonical or peer file by directory so peer-only
orphan scopes are not missed. It inspects files such as `CLAUDE.md`,
`GEMINI.md`, and profile-configured names. A peer file is not required to
exist, but when present it must be a valid symlink or a minimal pointer to the
same-scope `AGENTS.md`; any additional content must be clearly identified as
tool-specific and must not weaken the canonical rules.
The validator reports orphan peers, broken or cyclic links, missing canonical
references, exact copied common sections, and conflicting deltas with source
locations. Semantic similarity without deterministic proof remains a review
candidate rather than an automatic violation. The rule begins in warning mode
for existing repositories and can be ratcheted to blocking after a baseline.

Current implementation note: the first runnable slice implements only the
bounded, read-only `CQ-AGENT-001` portion with terminal and JSON output. Schema,
profile, waiver, provider, and general policy validation in this paragraph are
still planned. The current parser also rejects instruction sources above 10,000
lines or 50,000 Markdown syntax markers before AST construction and stops AST
traversal above 20,000 nodes; these conditions produce an explicit incomplete
result.

`cq integrations plan` is read-only and shows the exact managed snippets,
Skill locations, and files that an installation would affect. Installation and
uninstallation require explicit confirmation, modify only recognized managed
blocks or managed Skill directories, preserve unrelated user instructions, and
write atomically. They never replace a complete global or repository Agent
file. Codex integration targets the applicable global `AGENTS.md` and Codex
Skill location; Claude integration targets the applicable global `CLAUDE.md`
and Claude Code Skill location. Repository scope emits or installs local
routing artifacts and never overwrites an existing project policy.

`cq inspect readability` runs deterministic language analysis and the focused
semantic readability review without running unrelated security, concurrency,
or compatibility stages. It accepts the same local and forge inputs as
`cq review`.

`cq score` runs the review domains required by the selected score model and
prints the major, minor, total, coverage, confidence, and baseline-delta
scores. `cq review` and `cq inspect readability` accept `--score`; a focused
readability run reports only the readability subtotal and does not pretend to
produce a repository-wide total. `cq score --repository` performs a repository
health audit; change scores and repository scores are distinct scopes and are
never placed on one trend line.

### 7.2 Review inputs

```text
cq review --worktree
cq review --staged
cq review --commit <sha>
cq review --range <base>..<head>
cq review --repository [path]
cq review --repository [path] --preflight
cq score --repository [path] --preflight
cq review <github-pr-url>
cq review <gitlab-mr-url>
```

Exactly one input selector is accepted. The command resolves an immutable
snapshot before provider execution.

`--repository` is the explicit opt-in for a full-repository review; it is never
inferred from an omitted change selector. Before any model receives repository
content, the CLI performs a bounded read-only preflight and displays the
resolved repository, tracked and eligible untracked file counts, exclusions,
selected provider and endpoint class, data-egress class, token/time/cost
budgets, and truncation risks. Provider execution requires a second interactive
confirmation after that preview, bound to the displayed manifest hash.
`--preflight` performs no provider call and emits the manifest hash in terminal
or JSON output. Non-interactive execution requires both `--repository` and
`--confirm-full-repository <manifest-hash>`; the CLI recomputes the manifest and
rejects a mismatch before provider execution. A generic `--yes`, a stale hash,
or publication confirmation does not satisfy this scope confirmation. The same
preflight and hash-confirmation contract applies to `cq score --repository`.
Repository review and repository scoring share the `repository` scope but
remain separate commands.

The repository selector builds a content-addressed manifest from tracked files
and eligible worktree additions after applying Git ignores, profile exclusions,
binary/secret/generated/dependency filters, and hard file/byte limits. It never
silently expands to `.git`, dependency trees, generated output, caches, or
suspected secret files. Excluded and truncated categories remain visible in the
report and can force `INCOMPLETE`; confirmation cannot remove hard safety or
egress bounds.

### 7.3 Reports and publication

```text
cq report <run-id> [--format terminal|markdown|json]
cq review <input> --output <path>
cq review <input> --publish
cq review <input> --publish --yes
```

Publication is disabled by default. Interactive publication displays forge,
repository, change number, base SHA, head SHA, provider, finding counts, and
report hash before confirmation. Non-interactive publication requires both
`--publish` and `--yes`.

### 7.4 Hooks

```text
cq hooks install --mode warn
cq hooks install --mode block
cq hooks install --mode block --preset strict
cq hooks status
cq hooks uninstall
```

The installer inspects `core.hooksPath` and existing hook files. It creates or
updates only recognized managed hooks. If it finds an unrecognized hook, it
refuses to overwrite it and prints a chaining snippet. Hook installation is
always explicit.

## 8. Review Input and Snapshot Model

Every run binds to:

```text
input kind and scope
comparison base SHA or N/A
head SHA or synthetic worktree identity
diff hash or repository content-manifest hash
effective policy hash
prompt bundle version
provider adapter and version
model identifier
review preset
```

Worktree and staged inputs use a synthetic head derived from the relevant diff
and index metadata. Commit and range inputs use resolved object IDs. Forge
inputs use API metadata plus fetched Git objects. Full-repository inputs use a
synthetic identity derived from the resolved Git HEAD, index/worktree metadata,
the bounded selected-file manifest, and every exclusion or truncation decision.
The second confirmation binds to that manifest hash; a changed manifest requires
a new preflight and confirmation.

For a forge URL, the resolver reuses the current repository only when its
verified remote identity matches. Otherwise it uses a cached bare repository
and a disposable read-only worktree. Credentials are passed through request
headers or credential helpers and are never embedded in a Git remote URL.

Before publication, the forge adapter fetches current change metadata again. A
head mismatch marks the run `stale` and prevents publication.

The term `baseline` is not used without qualification:

- `comparison_base` is the Git revision used for the diff.
- `quality_baseline` is the accepted historical debt state.
- `benchmark_ground_truth` is labeled evaluation data.

## 9. Policy Model

### 9.1 Rule schema

Each rule has a stable ID such as `CQ-CONC-001` and contains:

```text
id
version
title
rationale
scope
triggers
default_severity
gate_mode
detection
required_evidence
remediation
verification
owner
examples
lifecycle
```

Rules are immutable within a version. A semantic change increments the rule
version and is recorded in the standards changelog.

The first rule pack includes the mandatory readability rules defined in
Section 11. It also includes universal correctness, concurrency, security,
testing, compatibility, and repository-hygiene rules derived from this
repository's current standards.

### 9.2 Repository profile

`.code-quality/profile.yaml` selects rule sets and defines:

- Repository identity and technology tags.
- Quality commands and their timeouts.
- Critical paths and risk triggers.
- Named provider and model policy without endpoint or secret definitions.
- Repository data classification and allowed provider classes.
- Stage, concurrency, token, time, and cost budgets.
- Hook presets and gate thresholds.
- Named forge targets and publication behavior without host or token mappings.
- Local rule overrides and waiver locations.
- Score-model selection and major or minor weight overrides.

### 9.3 Effective policy

Structured configuration precedence is:

1. Non-removable CLI safety invariants.
2. Explicit invocation flags.
3. Target repository profile.
4. Selected built-in or repository rule packs.
5. User-level CLI defaults.
6. Built-in defaults.

The CLI discovers `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and configured
instruction files from the repository root toward affected files. Arbitrary
natural-language instructions are included as hashed, ordered sources; they are
not silently converted into deterministic structured overrides. A host Agent is
responsible for passing higher-level session instructions that are not visible
to the CLI.

Instruction discovery and instruction reuse validation are separate. Discovery
determines which instructions affect a review. `CQ-AGENT-001` determines
whether each repository directory uses `AGENTS.md` as the canonical shared
source for same-directory peer files. Repositories may configure additional
peer filenames, but they cannot configure away conflict, cycle, or canonical
reference checks. A repository containing only a peer file and no same-scope
`AGENTS.md` is reported as an orphan scope so it can be migrated incrementally.

Credential-bearing provider definitions, provider base URLs, forge host/token
mappings, and maximum egress permissions live in trusted user configuration
outside the reviewed repository. A repository profile can select only a named
provider that the user configuration already permits. It cannot define an
authorization-header environment variable or redirect a token to a new host.

For PR and MR review, active policy and instructions come from the trusted base
revision. Proposed changes to policy, instructions, hooks, or provider selection
in the head revision are reviewed as untrusted change content and do not become
active during that review. Local users may explicitly review with a head policy
after a confirmation that shows the policy diff.

Each run emits `effective-policy.json` containing resolved structured values,
source locations, source hashes, overrides, detected conflicts, and unresolved
natural-language conflicts. Repository instructions cannot weaken the CLI's
authorization, secret handling, read-only default, publication confirmation, or
resource limits beyond explicitly permitted bounds.

## 10. Finding and Waiver Model

### 10.1 Finding schema

A finding contains:

```text
id
rule_id
title
severity
confidence
status
disposition
locations
trigger
actual_behavior
expected_behavior
impact
evidence
remediation
verification
review_stage
provider
model
timestamps
```

Allowed status transitions are:

```text
candidate -> corroborated -> confirmed -> reported
                        \-> dismissed
                        \-> uncertain
                        \-> waived
```

Severity measures impact if the issue is real. Confidence measures evidence
quality. `disposition` is one of `new`, `preexisting`, `unknown`, or
`not_applicable`. Blocking decisions require both a confirmed status and a
configured severity threshold. Confidence requirements are profile-controlled
and cannot be inferred from severity alone.

### 10.2 Waiver schema

A waiver contains:

- Rule ID and version range.
- Repository and path, symbol, change, or finding scope.
- Reason and risk acceptance statement.
- Approver and responsible owner.
- Compensating controls.
- Tracking issue.
- Creation and expiry time.

Expired waivers are invalid. Missing approver, owner, expiry, or compensating
control makes the waiver invalid. Waivers never suppress the finding from
stored results; they change gate disposition and remain visible in reports.

## 11. Human Readability and Changeability

Human readability is a first-release review domain, not a style-only add-on.
The system evaluates whether a maintainer can identify responsibility, state,
control flow, fallback precedence, side effects, failure behavior, and legal
transitions without mentally executing a large section of code.

### 11.1 Mandatory rule set

The initial rules are:

- `CQ-READ-001`: Oversized function or method with multiple reasons to change.
- `CQ-READ-002`: Oversized or growing hotspot file.
- `CQ-READ-003`: A `try/catch` boundary spanning multiple business phases or
  unrelated failure modes.
- `CQ-READ-004`: Nested ternaries, long nullish-coalescing chains, or combined
  conditional and fallback expressions that encode business precedence.
- `CQ-READ-005`: An implicit state machine whose legal states and transitions
  exist only in branch structure.
- `CQ-READ-006`: Repeated large inline result objects or many structurally
  different return shapes.
- `CQ-READ-007`: Error classification through broad string matching or a distant
  catch that has lost the operation-specific failure type.
- `CQ-READ-008`: Excessive cognitive distance between a decision, its side
  effect, its cleanup, and its returned result.

### 11.2 Deterministic analysis

The first release ships a TypeScript/JavaScript analyzer built on the TypeScript
compiler API. It reports source-ranged evidence for:

- File, function, method, and `try` block line spans.
- Control-flow nesting depth and decision-node count.
- Return, `await`, local-variable, and catch counts.
- Nested ternary depth.
- Nullish-coalescing chain length.
- Expressions combining ternary, optional chaining, boolean operators, and
  nullish coalescing.
- Large object literals and conditional result assembly.
- Distinct return-object shapes within one function.
- Changed functions and metric deltas relative to the comparison base.

The analyzer interface is language-neutral. Unsupported languages receive
semantic review with an explicit notice that deterministic readability metrics
were unavailable. The first release does not pretend that regex counts are a
language parser.

### 11.3 Thresholds and gates

Thresholds are signals with diff-aware gates:

- More than 80 function lines requires a single-responsibility assessment.
- A new or expanded function above 150 lines is a P2 readability finding and
  reaches the default block threshold in block mode.
- A new function above 300 lines is blocked unless an approved waiver explains
  a state-machine, generated-code, or measured performance constraint.
- A `try` block above 80 lines requires an error-boundary assessment.
- A new or expanded `try` block above 150 lines reaches the default block
  threshold.
- A new file above 600 lines requires a responsibility assessment; above 1,000
  lines it is a hard gate unless generated or covered by a valid waiver.
- Nested ternary depth of two or greater creates a review candidate.
- A nullish chain of three or more values creates a candidate when it combines
  multiple semantic sources or another conditional operator.
- A simple expression such as `value ?? defaultValue` is not a violation.

No single metric proves unreadability. Deterministic signals become confirmed
findings only when the source evidence shows mixed responsibility, hidden
business precedence, distant failure handling, an implicit state machine, or
similar maintenance cost. The 80-line thresholds trigger assessment only; the
150-line new/expanded function and `try` thresholds are profile-configurable
default blocks. A new function above 300 lines and a new file above 1,000 lines
are hard gates requiring a valid waiver.

### 11.4 Incremental hotspot ratchet

Existing hotspots are recorded rather than forcing a one-time rewrite. When a
change touches a function already over a threshold, block mode requires:

1. Function length, `try` span, control nesting, and decision-node metrics do
   not worsen.
2. Changed lines do not introduce a new readability violation.
3. At least one local hotspot metric improves, or an explicit waiver explains
   why a behavior-only emergency change cannot safely simplify the area.

File length is not used alone as a blocking metric because extracting a large
function can temporarily add lines while improving ownership. New files above
600 lines require a responsibility assessment; new files above 1,000 lines are
blocked unless generated or explicitly waived.

### 11.5 Semantic readability questions

The readability reviewer must answer with code evidence:

1. Can the unit's responsibility be stated in one business sentence?
2. Are business phases visible as named functions, types, or a state table?
3. Can fallback precedence be understood from names rather than operator order?
4. Does each error boundary cover one operation or one coherent phase?
5. Can a reader enumerate result variants from a discriminated type instead of
   comparing many inline object literals?
6. Can one behavior be changed without revalidating unrelated phases and side
   effects?

The reviewer must recommend semantic boundaries, result builders,
discriminated unions, explicit transition tables, or typed error mapping only
when they reduce real cognitive load. It must not satisfy thresholds by creating
pass-through helper fragments.

### 11.6 Motivating reference case

The local OctopusMCPServer export path demonstrates the target failure mode. At
the reviewed snapshot, `src/tools/export-data-tool.ts` is 1,730 lines and
`executeExportDataOnce()` is 979 lines. Its outer `try` covers roughly 858
lines. AST analysis found 36 awaits, 82 local declarations, 33 `if` statements,
17 returns, 46 nullish operators, 94 conditional expressions, eight levels of
control nesting, and nine large inline result objects.

The concern is not the existence of `??`. The function combines task status,
batch identity, cached state, resource previews, export creation, polling,
progress publication, response construction, and broad error translation in
one unit. Several expressions encode which of multiple data sources is
authoritative by mixing ternaries and nullish chains. This case will inform a
synthetic, non-source-copying benchmark fixture with expected findings.

## 12. Scoring and Gates

Scoring makes quality trends and tradeoffs visible. It does not decide whether
a confirmed safety, security, data-integrity, or concurrency defect is allowed.
Every result presents gate and score independently:

```text
Gate: PASS | WARN | BLOCK | INCOMPLETE
Score: 82.5/100.0
Delta: +1.8
Confidence: high
```

### 12.1 Default 100-point model

The first score model is:

| Major dimension | Points |
|---|---:|
| Behavior correctness | 20.0 |
| Human readability and changeability | 20.0 |
| Module boundaries and architecture | 12.0 |
| Testing and verifiability | 12.0 |
| Concurrency and resource safety | 12.0 |
| Security and privacy | 12.0 |
| API, data, and release compatibility | 6.0 |
| Observability, documentation, and supply chain | 6.0 |

The default readability subtotal is:

| Minor item | Points |
|---|---:|
| Naming, intent, and business terminology | 3.0 |
| Function responsibility and scale | 4.0 |
| Control flow and visible business phases | 4.0 |
| Conditional and fallback precedence clarity | 3.0 |
| `try/catch` and error boundaries | 3.0 |
| State, return types, and result shapes | 3.0 |

The default behavior-correctness subtotal is:

| Minor item | Points |
|---|---:|
| Intent and contract alignment | 4.0 |
| Primary-path behavior | 4.0 |
| Boundary and invalid-input behavior | 4.0 |
| Failure, timeout, retry, and cancellation behavior | 4.0 |
| State transitions, side effects, and idempotency | 4.0 |

The default module-boundary and architecture subtotal is:

| Minor item | Points |
|---|---:|
| Cohesion, responsibility, and ownership | 3.0 |
| Dependency direction and layer alignment | 3.0 |
| Public interface and encapsulation | 2.0 |
| Shared state and lifecycle ownership | 2.0 |
| Abstraction value and duplication | 2.0 |

The default testing and verifiability subtotal is:

| Minor item | Points |
|---|---:|
| Observable behavior coverage | 3.0 |
| Failure and boundary coverage | 3.0 |
| Concurrency and timing coverage | 2.0 |
| Determinism and test isolation | 2.0 |
| Integration and contract coverage | 2.0 |

The default concurrency and resource-safety subtotal is:

| Minor item | Points |
|---|---:|
| Hot-path amplification and capacity model | 2.0 |
| Race, atomicity, and TOCTOU protection | 2.0 |
| Lock scope, ownership, and contention | 2.0 |
| Single-flight, idempotency, and deduplication | 2.0 |
| Bounded work, retry, queue, and backpressure | 2.0 |
| Multi-instance, cache-stampede, and resource bounds | 2.0 |

The default security and privacy subtotal is:

| Minor item | Points |
|---|---:|
| Authentication, authorization, and tenant isolation | 3.0 |
| Input, injection, path, URL, and file safety | 3.0 |
| Secrets, privacy, logging, retention, and deletion | 3.0 |
| Trust boundaries, data egress, and least privilege | 3.0 |

The default API, data, and release-compatibility subtotal is:

| Minor item | Points |
|---|---:|
| API, event, and schema compatibility | 2.0 |
| Data migration and multi-version behavior | 2.0 |
| Configuration, rollout, rollback, and deprecation | 2.0 |

The default observability, documentation, and supply-chain subtotal is:

| Minor item | Points |
|---|---:|
| Errors, logs, metrics, traces, and alerts | 2.0 |
| Documentation, Agent instruction reuse, repository hygiene, and operability | 2.0 |
| Dependencies, licenses, provenance, and release integrity | 2.0 |

New minor items are added through a score-model version, not through hidden
prompt changes. A model version cannot contain an unnamed remainder bucket.

### 12.2 Anchored minor-item ratings

Each minor item is rated from 0.0 to 5.0 in 0.5 increments and converted to its
weighted points. Every rating level has domain-specific evidence anchors. The
shared interpretation is:

```text
5.0  Evidence is complete and no material gap exists.
4.0  A small gap exists but does not impede local understanding or change.
3.0  Material maintenance cost exists and behavior needs cross-code checking.
2.0  Key behavior is difficult to prove or modification is regression-prone.
1.0  Structure is severely mixed and depends on tests or author knowledge.
0.0  The unit cannot be reviewed reliably or has a confirmed critical failure.
```

Intermediate half-step ratings require evidence that falls between adjacent
anchors. The report includes the rating, earned points, maximum points,
confidence, evidence locations, and explanation for every minor item.

### 12.3 Applicability and coverage

Each item is `scored`, `not_applicable`, or `not_assessed`.

- `not_applicable` is excluded from applicable points and must include a reason.
- `not_assessed` remains an explicit coverage gap and prevents a full-score
  claim.
- A focused review reports only its domain subtotal.

Full reports show both raw and normalized values:

```text
Raw: 73.0/86.0 assessed points
Applicable maximum: 100.0
Normalized: 84.9/100.0
Coverage: 86.0/100.0
```

Normalization never hides which dimensions were not applicable or assessed.
When required items are not assessed, the gate is `INCOMPLETE` even if the
available normalized score is high.

Every score records `scope` as `change`, `affected_surface`, `repository`, or
`focused_domain`. Baselines and trends compare only identical scopes.

### 12.4 Profile weights and model versions

A profile may change major weights, minor weights, or add repository-specific
minor items. Before per-run applicability is evaluated, the complete named
score model must sum to exactly `100.0` points at one-decimal precision. The
per-run applicable maximum may be lower after justified `not_applicable` items
are excluded. A zero-weight critical domain does not disable its rules or gates.

Every result records score-model ID, score-model version, profile hash, rule
versions, and rounding mode. Adding, deleting, renaming, re-anchoring, or
reweighting an item creates a new score-model version. Trend comparisons require
the same score-model version and compatible profile weights; otherwise the CLI
labels the comparison non-equivalent.

All displayed points, totals, normalized scores, coverage, and deltas use one
decimal place. Internal calculation retains higher precision and rounds only at
the presentation boundary using one documented rounding rule.

### 12.5 Baselines and gates

The score report compares the current snapshot with the selected quality
baseline and shows every major and minor delta. Historical low scores do not
force a one-time rewrite, but a changed hotspot cannot silently reduce an
applicable score or violate its metric ratchet.

P0/P1 findings, configured P2 findings, secret exposure, data corruption,
unsafe concurrency amplification, invalid policy, and incomplete mandatory
review retain their gate semantics regardless of total score. A high score
cannot compensate for a blocking finding. A low score without a blocking
finding is a prioritization and trend signal.

## 13. Review Pipeline

### 13.1 Planning

The deterministic risk router always selects universal intent, behavior, human
readability, test, and concurrency/resource assessment. The concurrency stage
may record `N/A` only with evidence covering all seven mandatory questions.
Rule and profile triggers add deeper concurrency specialists plus security,
data, performance, API compatibility, UI, or other specialist stages. A model
may add stages but cannot remove a deterministically required stage.

### 13.2 Context collection

The context collector reads the diff, full changed functions or units, direct
callers and dependencies, relevant schemas, tests, instruction files, and
change-series context within configured limits. Missing or truncated context is
recorded and lowers confidence.

Reading tests is different from executing them. Remote PR and MR review does
not execute target code, build scripts, package-manager scripts, or repository
commands by default. `--run-checks` is a separate explicit authorization. It
shows the exact commands first, removes unrelated secret environment variables,
applies time and output limits, and records that untrusted code was executed.
Future CI execution requires an isolated runner with no production credentials.

Repository content, commit messages, PR descriptions, comments, and source
comments are data, not trusted instructions. Provider prompts place them in
explicitly delimited untrusted sections.

### 13.3 Specialist execution

Specialist stages emit schema-validated `candidate` concerns and explicitly
dismissed concerns. They do not emit publishable prose. The default full preset
permits at most seven stages and two simultaneous provider requests. The fast
hook preset performs one bounded general risk pass.

### 13.4 Consolidation and conflict resolution

The orchestrator groups candidates by root cause, affected path, and behavior.
It preserves the most precise evidence and every source stage. A separate pass
compares candidate and dismissed reasoning. Contradictory conclusions remain
`uncertain` until code evidence resolves them.

### 13.5 Verification and classification

The verifier must prove the execution path or contract violation before marking
a candidate `confirmed`. It checks the comparison base to distinguish new and
preexisting issues and checks later commits in a series before reporting an
issue from an earlier commit.

The primary provider may perform verification by default. A profile may select
an independent verifier provider. Provider agreement raises confidence but does
not replace code, test, runtime, history, or specification evidence.

### 13.6 Reporting

Reporters consume only the normalized run result. Terminal and Markdown reports
lead with confirmed findings ordered by severity, then uncertain candidates,
waived findings, open questions, verification, concurrency review, and residual
risk. Every report includes a readability section with current metrics, deltas,
confirmed semantic concerns, and hotspot-ratchet status. JSON output is the
stable interchange format. When scoring is requested, the report also includes
every major and minor score, evidence, confidence, coverage, score-model
version, and baseline delta.

## 14. Provider Adapters

All providers implement a common typed contract:

```text
capabilities()
review(request)
validateConfiguration()
redactDiagnostic()
```

The request includes system instructions, untrusted code context, JSON schema,
token limits, timeout, and run identifiers. The response includes structured
content, usage, finish reason, provider request ID, and truncation state.

### 14.1 Local CLI providers

Codex and Claude are invoked directly without a shell. Arguments are passed as
an array, stdin carries the request, stdout is parsed as a documented adapter
format, and stderr is sanitized. Provider-specific commands are isolated behind
contract tests because local CLI flags can change independently.

Local CLI providers run from an isolated temporary directory and receive the
collected context through stdin. The adapter must enable the provider's
no-tools or read-only sandbox controls and pass a minimal environment. If the
installed provider version cannot enforce the required mode, configuration
validation fails rather than running it with broader access.

### 14.2 OpenAI-compatible provider

The first release supports the Chat Completions-compatible endpoint. Trusted
user configuration outside the reviewed repository supplies base URL,
environment-backed headers, and the environment variable containing the API
key. A repository profile may select only a named, already trusted provider and
an allowed model policy. Secret values and credential-routing metadata are
never serialized into repository policy or the effective policy.

### 14.3 Anthropic-compatible provider

The first release supports the Messages-compatible endpoint with the same
trusted user-configuration boundary for base URL, model allowlist,
environment-backed headers, and secret handling.

### 14.4 Endpoint safety

HTTPS is required except for explicit localhost development endpoints.
Cross-origin redirects are rejected so authorization headers cannot be
forwarded to another host. Response bodies, headers, and diagnostics are size
bounded and redacted.

Invalid structured output receives at most one schema-repair attempt within the
global attempt budget. It never becomes an empty successful report.

## 15. Forge Adapters and Publication

GitHub and GitLab adapters support public changes without credentials when the
forge permits it and private changes through environment-provided tokens. Tokens
must be scoped read-only unless publication is explicitly used.

Token environment variables are mapped only to forge hosts in trusted user
configuration. A PR or MR URL cannot choose which token is loaded. The built-in
public host mappings are `github.com` and `gitlab.com`; enterprise hosts require
an explicit trusted mapping.

Forge adapters resolve:

- Host, repository, and change number.
- Base and head revisions.
- Change title, description, and commit sequence.
- Diff and changed-file metadata.
- Current publication permissions.

Publication uses this idempotency identity:

```text
forge + repository + change number + head SHA + report hash
```

Published content contains a stable hidden marker. Before creating a comment,
the adapter searches for an existing marker and updates or reuses it according
to profile policy. A retry cannot create duplicate comments. Publication logs
store target metadata and result IDs, not credentials.

## 16. Storage and Retention

Tracked repository configuration lives under `.code-quality/`. Runtime state
does not enter the target repository by default:

- Run metadata and sanitized results use the platform state directory.
- Reusable content-addressed cache uses the platform cache directory.
- Explicit `--output` writes a user-selected report.
- Full prompts, source context, and raw model responses are not retained by
  default.
- `--retain-transcript` writes a permission-restricted transcript and marks the
  run as sensitive.

Run metadata records hashes and versions needed for reproducibility without
retaining source content. Cache entries are bounded by size and retention time.

## 17. Git Hook Strategy

The default balanced preset is:

```text
pre-commit: deterministic checks + one fast cached AI review, warning mode
pre-push: full review of changes since the upstream base
```

The deterministic readability analyzer runs in both hooks. It prevents AI or
human changes from silently adding a new oversized function, widening a giant
`try`, or worsening a recorded hotspot even when a provider is unavailable.

The strict preset permits a full review before every commit. The hook cache key
contains the snapshot, policy, prompt, provider adapter, model, and preset. An
unchanged staged snapshot reuses the prior result.

`warn` mode never prevents a commit or push. `block` mode returns the CLI gate
exit status. Profiles choose fail-open or fail-closed behavior for incomplete
reviews. The default is fail-open for local provider or network failures while
still displaying a prominent incomplete-review warning.

Users may bypass local hooks with Git options. Future server-side required
checks are the enforcement mechanism when operational support is available.

## 18. Error and Exit Semantics

```text
0  Review completed and no confirmed finding reached the gate threshold
1  A confirmed finding reached the configured gate threshold
2  Input, configuration, rule, profile, schema, or waiver is invalid
3  Review is incomplete because of provider, network, timeout, or context failure
4  Review completed but requested publication failed
```

No-findings and incomplete-review results are distinct states. Reports always
list commands that ran, commands that failed, tests not run, truncated context,
and remaining risk.

## 19. Security Model

### 19.1 Authorization

The CLI is read-only by default. It does not modify reviewed code, Git history,
branches, remotes, issues, or change discussions. Hook installation,
initialization writes, transcript retention, and publication each require
explicit commands. Publication also requires confirmation.

### 19.2 Prompt injection

All target repository content is untrusted. The model receives no arbitrary
shell tool. Read operations are allowlisted, path-contained, size-bounded, and
logged by normalized operation rather than raw secret-bearing arguments.

### 19.3 Data egress

Profiles classify repositories and select permitted provider names and data
classes. Trusted user configuration defines provider hosts, endpoints, and
maximum egress permissions. A run stops before sending content when the selected
provider is not allowed for the data class. Reports state which provider received
which categories of context.

### 19.4 Secrets

API keys and forge tokens come from named environment variables. Configuration
stores only environment variable names. Redaction covers request headers,
provider diagnostics, child-process errors, reports, and transcripts metadata.

### 19.5 Target code execution

Reviewing source is read-only analysis. Running target repository commands is a
separate capability with explicit authorization, a sanitized environment,
timeouts, output limits, and no publication on partial execution. Remote change
authors cannot add or alter the commands that execute during their own review;
commands come from the trusted base policy.

### 19.6 CLI supply chain

The repository commits its pnpm lockfile, reviews dependency and license
changes, scans committed content for secrets, and uses pinned immutable action
revisions in inactive CI templates. Dependency scripts are not assumed safe;
installation and release documentation states when scripts run and which
packages require them. Release provenance and package signing are a later
operational step because no package registry publication is authorized in the
first release.

## 20. Concurrency and Resource Review

### 20.1 Hot path amplification

Every commit hook can initiate model work. The balanced preset limits
pre-commit to one specialist pass and caches by content. Full review runs at
pre-push or explicit invocation. Default full review limits are seven stages,
two concurrent provider requests, and sixteen total provider attempts including
retries and schema repair.

The hard request bound is:

```text
peak provider work <= active reviews x min(2, selected runnable stages)
total attempts per review <= 16
```

No request creates a timer, job, or persistent queue item beyond its bounded run
record and cache entry.

### 20.2 Race and TOCTOU protection

Review and publication use immutable snapshot identities. The CLI verifies the
worktree or forge head before reusing a result and again before publication.
Atomic file creation and rename protect run and cache writes.

### 20.3 Lock scope and contention

Single-flight locks are scoped to a content-addressed review key, never the
whole repository or user account. A winner holds a renewable lease during the
provider run. Losers wait for a bounded interval or exit with an incomplete
status. Lock release verifies a random owner token so an expired owner cannot
release a successor's lock.

### 20.4 Single-flight and deduplication

Only the atomic lock winner invokes providers for a review key. Losers reuse the
completed result. Publication independently deduplicates through the forge
marker and publication identity.

### 20.5 Bounded background work

The first release has no daemon or detached work. Provider requests, retries,
schema repairs, Git commands, child processes, and publication calls all have
timeouts and hard count limits. Cancellation terminates child processes and
prevents later publication.

### 20.6 Stampede and multi-instance behavior

Local single-flight coordinates processes sharing the same state directory. It
does not claim cross-machine coordination. Forge publication idempotency is the
shared backstop across machines. A future CI service must add a shared lock or
check-run identity before enabling concurrent distributed workers.

### 20.7 Resource bounds

Initial full-review defaults are:

- 200 changed files.
- 10,000 changed lines.
- 2 MiB normalized diff.
- Seven review stages.
- Two provider requests in flight.
- Sixteen total provider attempts.
- 500,000 aggregate input and output tokens.
- Fifteen minutes wall-clock time.
- A configurable cache size and retention period with least-recently-used
  cleanup.

Full-repository review additionally defaults to at most 5,000 selected source
files and 50 MiB of selected raw file content before staged context reduction.
It remains subject to the 500,000 aggregate token and fifteen-minute run budgets.
The preflight does not call a model, and exceeding any hard repository bound
produces `INCOMPLETE` rather than silently sampling a different scope.

The fast hook preset uses lower file, token, request, and time budgets. Exceeding
a bound produces an explicit incomplete or reduced-scope result, not silent
success.

### 20.8 Residual concurrency risk

Separate machines may still perform duplicate model work because the first
release has no shared lock. They must not create duplicate external comments
because publication is idempotent. Provider-side rate limits and shared account
quotas remain external constraints and are surfaced as incomplete-review
diagnostics.

## 21. Agent Integration Design

The root `AGENTS.md` retains:

- Git commit, push, and PR authority.
- Instruction precedence.
- Review-versus-modification boundaries.
- Dirty worktree protection.
- Evidence and verification requirements.
- Mandatory production concurrency review.
- Secret and external-side-effect constraints.
- Routes to CLI, Skill, standards, playbooks, schemas, and templates.

Detailed coding and review checklists move to `docs/standards/`. The repository
does not modify a user-level global instruction file or another repository's
`AGENTS.md` during ordinary review. Only the explicit `cq integrations install`
workflow may make a scoped managed change after showing a plan and receiving
confirmation.

Codex and Claude Code can each be a host Agent that invokes the CLI, or a review
provider invoked by the CLI. Host integration and provider configuration are
independent roles. Both Skills invoke the same CLI, interpret exit states,
present findings, and handle publication confirmation. They reference rule IDs
and CLI commands and do not copy standards or machine policy. A Skill must not
turn an analysis-only request into code modification or publication.

User-level Agent snippets are intentionally small trigger contracts. They route
review requests to a full review, production-code completion checks to the
affected worktree review, and commit preparation to the fast staged preset.
They do not run a model after every conversational turn. Project profiles may
adjust presets and warning thresholds within non-removable safety bounds. A Git
hook provides an Agent-independent pre-commit fallback; later CI can provide a
non-local enforcement layer.

## 22. CI Reservation

CI assets live under `templates/ci/` and therefore do not execute. The project
documents required permissions, secrets, expected check names, caching, and
branch-protection setup for later operational adoption. Templates use pinned
action revisions and least-privilege permissions.

## 23. Testing and Benchmarking

### 23.1 Automated tests

- Schema tests cover valid and invalid rule, profile, finding, waiver, and run
  fixtures.
- Policy tests cover precedence, conflicts, expired waivers, and effective
  policy output.
- Instruction tests cover `CQ-AGENT-001` same-scope pointers, valid symlinks,
  tool-specific deltas, orphan peers, copied sections, conflicts, cycles, and
  configured peer names. The current executable slice additionally covers
  recursive reference definitions, exact canonical-reference boundaries,
  read/follow directive binding, strongly connected cycle evidence, and
  Markdown line, marker, and AST-node limits.
- Review tests cover deterministic routing, finding transitions, deduplication,
  confidence, disposition, and gates.
- Readability analyzer tests cover changed-function ranges, thresholds,
  hotspot deltas, wide `try` blocks, nested ternaries, semantic nullish chains,
  return-object shapes, and non-violating simple fallback expressions.
- Scoring tests cover weight validation, one-decimal output, internal rounding,
  applicability, missing assessment, profile overrides, model-version
  compatibility, baseline deltas, and gates that cannot be offset by points.
- Provider contract tests use fake executables and local HTTP servers.
- Forge contract tests cover URL parsing, metadata, stale heads, permissions,
  and idempotent publication.
- Git integration tests use temporary repositories for every local input and
  hook mode.
- End-to-end tests use a deterministic fake provider and no external network.
- Real-provider smoke tests are opt-in and excluded from default verification.

### 23.2 Benchmarking

The first benchmark corpus includes known defects, clean changes, historical
defects, and adversarial prompt-injection cases. Each result records exact,
partial, missed, false-positive, duplicate, and unstable outcomes plus tokens,
latency, provider, model, prompt version, and rule version.

Evaluation reports precision, recall, false-positive rate, duplicate rate, and
repeat-run stability. High-severity misses are reported separately and cannot be
hidden by aggregate averages. AI judging may assist triage but does not replace
a maintained human-labeled evaluation subset.

The readability corpus includes synthetic examples derived from the structural
properties of the OctopusMCPServer export path: a giant orchestrator, a wide
error boundary, hidden fallback precedence, repeated large result objects, and
an implicit state machine. It also includes clean counterexamples so ordinary
nullish coalescing and small ternaries do not become noisy findings.

## 24. Verification Commands

The repository will expose:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm check:dependencies
pnpm check:secrets
pnpm check
```

`pnpm check` runs the release-relevant local suite. No command silently lowers a
rule, ignores a failure, or publishes external state.

## 25. First-release Acceptance Criteria

The first release is complete when:

1. All seven change and repository input forms produce the same normalized
   snapshot contract.
2. All four provider adapters pass contract tests.
3. GitHub and GitLab adapters can read changes and publish idempotently after
   confirmation.
4. Rules, profiles, findings, waivers, and run records pass strict schemas.
5. Effective policy output explains structured precedence and instruction
   sources.
6. Mandatory risk routing cannot be disabled by model planning.
7. Candidate concerns cannot reach a blocking report without verification.
8. TypeScript/JavaScript readability analysis detects oversized functions,
   wide `try` blocks, nested conditional/fallback expressions, implicit result
   shape proliferation, and hotspot regressions with source-ranged evidence.
9. The Octopus-derived synthetic readability fixture produces the expected
   findings while simple nullish and ternary counterexamples remain clean.
10. The default and profile-adjusted score models validate to 100.0, emit every
    major and minor item to one decimal place, preserve applicability coverage,
    and keep gate decisions independent from total score.
11. Fast and full hook presets work without overwriting unrelated hooks.
12. Default storage excludes raw prompts, source context, and model responses.
13. Resource limits, stale detection, single-flight, and publication
    idempotency have automated tests.
14. Codex and Claude Code Skills plus user-level and repository snippets route
    to the CLI and standards without duplicating machine policy, and their
    installers preserve unrelated existing instructions.
15. `CQ-AGENT-001` deterministically validates same-directory Agent document
    reuse, produces source-ranged diagnostics, and supports warn-to-block
    baseline ratcheting without treating absent optional peer files as errors.
16. Untrusted head revisions cannot select credentials, endpoints, active
    policy, instruction files, or executable quality commands.
17. CI templates remain inactive.
18. Format, lint, typecheck, unit, integration, dependency, secret, and build
    commands pass.
19. Full-repository review remains opt-in, previews scope/egress/budgets without
    provider execution, requires a distinct second confirmation bound to the
    manifest hash, and enforces the same rule, finding, scoring, and Gate model.

## 26. Delivery Sequence

Implementation will proceed as independently verifiable increments:

1. TypeScript package, schemas, domain types, and validation command.
2. Rule, profile, waiver, and effective-policy engine.
3. Versioned scoring model, weight validation, and baseline deltas.
4. TypeScript/JavaScript readability analyzer and hotspot baseline.
5. Git input normalization and immutable snapshots.
6. Provider interfaces and four adapters.
7. Deterministic planning, staged review, verification, and reporting.
8. GitHub and GitLab read adapters.
9. Storage, cache, locks, and resource budgets.
10. Optional idempotent publication.
11. Git hooks and presets.
12. Benchmark harness and initial readability and defect corpora.
13. `AGENTS.md` split, standards, playbooks, templates, Codex/Claude Code
    Skills, integration snippets, and `CQ-AGENT-001` validation.
14. Inactive CI templates and final end-to-end verification.
