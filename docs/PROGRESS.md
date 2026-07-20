# First-release acceptance progress

Measured against section 25 of
`docs/superpowers/specs/2026-07-19-code-quality-cli-design.md`.

Status values are deliberately narrow:

- `Complete`: implementation and deterministic evidence exist.
- `Partial`: implementation exists, but a required verification is not current.
- `Failed`: a criterion is missing or current evidence disproves it.

The generated percentage is:

```text
(complete + 0.5 x partial) / 19 x 100
```

Run `corepack pnpm check:progress` to validate the row count, statuses, release
threshold, and generated percentage. As of 2026-07-20 the matrix contains 18
`Complete`, 1 `Partial`, and 0 `Failed`: **97.4%**. The release Gate remains
`INCOMPLETE` because the dependency audit was not run under the current
no-external-service constraint.

## Acceptance matrix

| #   | Criterion                                                                                         | Status   | Evidence                                                                                |
| --- | ------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| 1   | Seven input forms share the normalized immutable snapshot contract                                | Complete | `git-inputs.test.ts`, `forge-materialize.test.ts`, `repository-preflight.test.ts`       |
| 2   | Four Provider adapters pass bounded contract tests                                                | Complete | focused process, HTTP, probe, soak, and resource-release Provider tests                 |
| 3   | GitHub and GitLab read changes and publish idempotently after confirmation                        | Complete | `github-files.test.ts`, `gitlab.test.ts`, `publish.test.ts`, Forge CLI integration      |
| 4   | Rules, profiles, findings, waivers, and runs use strict schemas                                   | Complete | package policy asset tests and focused core schema tests                                |
| 5   | Effective policy explains precedence and instruction sources                                      | Complete | `policy.test.ts`, validation integration tests                                          |
| 6   | Mandatory risk routing cannot be disabled by model planning                                       | Complete | planner, assessment-plan, depth, and orchestrator tests                                 |
| 7   | Blocking findings require path-linked corroborated evidence                                       | Complete | stage-output, verifier, and orchestrator tests                                          |
| 8   | Readability analysis detects all required structural signals and hotspot regressions              | Complete | readability and TypeScript analyzer tests                                               |
| 9   | Octopus-derived defects are detected while clean counterexamples remain clean                     | Complete | packaged benchmark corpus and benchmark runner tests                                    |
| 10  | Default and profile scoring models total 100.0 with applicability and independent gates           | Complete | scoring model, calculation, baseline, profile, and score-bridge tests                   |
| 11  | Fast and full Hook presets preserve unrelated Hook content                                        | Complete | Hook preset and integration tests                                                       |
| 12  | Default storage excludes raw prompts, source context, and model responses                         | Complete | transcript, run projection, run schema, and secret redaction tests                      |
| 13  | Limits, stale detection, single-flight, and publish idempotency have automated tests              | Complete | lock, cache, run, single-flight, run-check, Provider bound, and publish tests           |
| 14  | Agent Skills and snippets route to CLI without duplicating machine policy                         | Complete | integration installer and instruction integration tests                                 |
| 15  | CQ-AGENT-001 validates same-scope reuse with ranged diagnostics and ratcheting                    | Complete | discovery, graph, reuse-validator, CLI validate, and bounded-reader tests               |
| 16  | Untrusted heads cannot select credentials, endpoints, policy, instructions, or commands           | Complete | base-policy, user-config, executable-source, Forge materialization, and preflight tests |
| 17  | CI templates remain inactive and install only after confirmation                                  | Complete | CI install tests; no active repository workflow is shipped                              |
| 18  | Format, lint, typecheck, tests, dependency audit, secret scan, and build pass                     | Partial  | all local checks except the network-backed dependency audit have fresh evidence         |
| 19  | Full-repository review is opt-in and confirmation binds scope, egress, budgets, and manifest hash | Complete | repository preflight and CLI review integration tests                                   |

## Current evidence

- `format:check`, `lint`, `typecheck`, and `build`: PASS on 2026-07-20.
- `test:coverage`: PASS with 80 files, 907 passing tests, and 2 skipped tests;
  166/166 runtime modules were observed (100.0%) and 2,421/2,660 runtime
  functions were observed (91.0%). Pure type-only files are excluded.
- Changed-production readability ratchet: PASS for 110 TypeScript/JavaScript
  files with 262 semantic-review candidates, 0 incomplete analyses, 0 hard
  gates, 0 blocking signals, and 0 expanded hotspots.
- Repeated concurrency suite: PASS for 20/20 rounds over lock,
  single-flight, publication, and Hook races; each round passed 56 tests with
  2 conditionally skipped tests. The focused cross-process waiter test also
  proved that 64 active waiters poll and the 65th is rejected before polling.
- `check:secrets`: PASS for 318 release files and 2,290,256 bytes.
- `benchmark`: PASS for 7 exact cases, 9 true positives, no false positive,
  false negative, duplicate, unstable result, or high-severity miss.
- Offline tarball install: PASS; installed `cq --help`,
  `code-quality --help`, and the packaged progress checker all passed.
- `check:dependencies`: NOT RUN because it requires external registry access.
- Independent spec and code-quality review: NOT RUN because this continuation
  is intentionally restricted to one Agent.

## Concurrency and resource review

- **Hot path amplification:** the CLI has no daemon or detached queue. One
  full review runs at most 7 stages, 2 Provider calls concurrently, and 16
  total Provider attempts; fast mode is limited to 1 stage, 1 concurrent call,
  and 2 attempts. For `N` distinct concurrent CLI reviews, active Provider
  calls are therefore at most `2 x N`; deployment must bound `N` at the CI or
  process-runner layer.
- **Race protection:** review identity binds repository, immutable content,
  Provider, model, policy, prompt, preset, and score model. Atomic lock
  directories, generation guards, owner tokens, and PID liveness prevent
  check-then-act reclamation races on one host. Publication binds forge,
  repository, change number, head SHA, and report hash, then reconciles the
  remote comment list.
- **Lock scope:** the review lock covers Provider execution, durable run
  persistence, and cache publication. Its lease defaults to at least 60
  seconds and renews every lease/3; loser waits are capped at 60 seconds.
  Maintenance-lock waits are capped at 2 seconds. A lock root permits 1,024
  containers and 128 artifacts per container, with at most 32 cleanup removals
  per acquire.
- **Single-flight / dedupe:** one local-host winner executes a given review key;
  at most 64 filesystem-backed losers wait and the next caller returns
  `SINGLE_FLIGHT_WAITER_LIMIT`. Losers publish no run, cache entry, task, or
  external side effect. A winner persists the run before publishing a reusable
  cache entry, and an unavailable result is reported as `INCOMPLETE`.
- **Bounded background work:** there is no persistent background worker.
  Provider processes have deadlines, cancellation, forced group termination,
  and byte caps. Publication permits at most 128 in-process target lanes and 16
  active-or-queued calls per lane (2,048 total), with at most 2 remote mutation
  attempts. Executable snapshots permit 2 active copies and 512 MiB reserved
  bytes per process; Provider probes permit 128 child processes per process.
- **Stampede / multi-instance:** local paths and locks coordinate only one
  host. A shared directory changes artifact placement but does not claim
  cross-machine CAS or fencing. Cross-machine duplicate computation remains
  possible; forge publication uses remote reconciliation, while a distributed
  execution deployment still requires an external fencing coordinator.
- **Resource estimate:** local review context is capped at 40 files, 64 KiB per
  file, and 512 KiB total. Full-repository preflight is capped at 5,000 files,
  20,000 entries, 1 MiB per file, and 50 MiB total. Cache retention is at most
  256 entries, 128 MiB total, 8 MiB per entry, and 7 days, with 32 removals per
  pass. Run storage is at most 200 entries and 16 MiB per entry (3.125 GiB
  theoretical maximum), with 32 removals per write. Peak same-key local work is
  1 Provider winner plus 64 bounded waiters, independent of incoming request
  count after rejection begins.
- **Residual risk:** distinct-key CLI processes are not globally rate-limited;
  CI/operations must cap concurrent invocations. Cross-machine single-flight
  and strongly consistent remote-comment listing are external-system concerns.
  Live Provider/forge soak and registry-backed dependency audit remain pending
  explicit environment access.

## Operational follow-up

These do not change the 19-row implementation score, but they are required for
an environment-specific production sign-off:

1. Run `cq providers validate --live` against explicitly approved real CLIs and
   credentials.
2. Run `check:dependencies` with registry access and preserve its evidence.
3. Have operations install CI and enable the required branch-protection check.
4. Add an external fencing coordinator before claiming cross-machine
   single-flight; shared paths provide placement, not global CAS.
