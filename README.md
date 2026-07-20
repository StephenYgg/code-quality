# Code Quality

Code Quality is an evidence-driven, incremental code review system. The first-release CLI is runnable: deterministic policy/scoring/readability, local Git snapshots, full-repository preflight, provider adapters with opt-in live soak, review orchestration with full 100.0 scoring, forge materialize/publish, hooks with presets, operator-selected storage paths with local-host coordination, transcript retention, and ops-gated CI install.

## Current Capability

The CLI currently provides:

- `cq validate [repository]`: aggregates `CQ-AGENT-001` with strict profile, rule-pack, schema, provider-selection, and waiver validation without invoking a model;
- `cq rules list` and `cq rules explain <rule-id>`: inspect the effective deterministic rule catalog;
- `cq inspect readability <file>`: run bounded TypeScript/JavaScript AST analysis for `CQ-READ-001` through `CQ-READ-008` candidates;
- `cq score <input.json>`: calculate the versioned 100.0-point model from validated assessments, including focused-domain and baseline-delta results;
- `cq review --worktree|--staged|--commit|--range|--repository|--forge-url`: capture immutable inputs and run bounded review orchestration using trusted user provider config (except repository `--preflight`);
- `cq review --provider/--model/--config`: select a named trusted provider/model or override the user config path;
- `cq review --repository --preflight` and `--confirm-full-repository <hash>`: full-repository manifest confirmation without inferring scope;
- `cq report <run-id>` and `cq runs`: render and list stored sanitized run records;
- `cq providers validate`: soak-probe trusted user providers (CLI safe-mode flags/version and HTTP config) without sending repository content;
- `cq review --score`: append the full versioned 100.0 score model report derived from the review;
- `cq review --review-preset fast|full`: use hook-style fast budgets or full stage routing;
- `cq init [--confirm]`: plan or create `.code-quality/profile.yaml` without replacing `AGENTS.md`;
- `cq hooks install|status|uninstall|run`: managed local Git hooks with balanced/strict presets, fail-open incomplete policy, and cache-key UX.

`CQ-AGENT-001` validates that same-directory Agent instruction files reuse `AGENTS.md` as their canonical shared source. It checks:

It currently checks:

- orphan `CLAUDE.md` or `GEMINI.md` scopes without a same-directory `AGENTS.md`;
- missing or parent-directory canonical references;
- references that mention `AGENTS.md` without requiring it to be read and followed;
- valid and broken peer symlinks;
- Markdown reference cycles;
- explicit instructions that ignore or override `AGENTS.md`;
- second-level sections not identified as canonical pointers or tool-specific deltas;
- normalized nontrivial policy blocks copied exactly from `AGENTS.md`;
- bounded directory, instruction-file, per-file byte, total-byte, and Markdown parsing;
- source line/column evidence, bounded diagnostics, and terminal-safe output.

`CQ-AGENT-001` is advisory by default. Policy findings produce `Gate: WARN`; bounded scanning, stable-read, or platform capability failures produce `Gate: INCOMPLETE`. Invalid schemas, profiles, rule references, or waivers are configuration errors and remain distinct from incomplete validation.

The readability command reports deterministic candidates and metrics, not confirmed semantic findings. Its focused score is explicitly `not_assessed` rather than treating the absence of a metric signal as a perfect score. Reports return at most 128 candidates/diagnostics and become `INCOMPLETE` when more evidence exists.

## Build and Run

Prerequisites: Node.js 22 or a newer compatible release, plus Corepack.

```bash
corepack pnpm install
corepack pnpm build
node dist/cli.js validate /path/to/repository
node dist/cli.js validate /path/to/repository --format json
node dist/cli.js rules list
node dist/cli.js rules explain CQ-READ-003 --format json
node dist/cli.js inspect readability src/example.ts
node dist/cli.js score assessment.json --format json
node dist/cli.js review --repository --preflight
node dist/cli.js review --staged
node dist/cli.js review --staged --provider codex --model gpt-5
node dist/cli.js runs
node dist/cli.js providers validate
node dist/cli.js providers validate --format json
node dist/cli.js review --staged --score
node dist/cli.js hooks status
node dist/cli.js hooks install --mode warn --preset balanced
node dist/cli.js hooks run pre-commit --mode warn --preset balanced
```

### Trusted user provider config

Provider endpoints, executables, and credential environment names live **outside**
reviewed repositories. Copy
[`templates/user-config/config.example.yaml`](templates/user-config/config.example.yaml)
to one of:

- macOS: `~/Library/Application Support/code-quality/config.yaml`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/code-quality/config.yaml`
- override: `CQ_CONFIG_PATH=/abs/path/config.yaml` or `cq review --config /abs/path/config.yaml`

Repository profiles may only select a provider name already present in that
user config. They cannot redefine endpoints or credential env vars.

The package declares `cq` and `code-quality` binaries, but the commands above use the built entry point directly and do not assume a global installation.

Exit codes:

- `0`: `PASS` or advisory `WARN`;
- `1`: a deterministic gate reached `BLOCK` or confirmed blocking findings;
- `2`: invalid input or configuration;
- `3`: `INCOMPLETE` validation or review;
- `4`: publication failure (when publication is used).

Default instruction validation limits are 20,000 directories, 200,000 total directory entries, 5,000 instruction files, 1 MiB per-file content, 16 MiB total content, and 1,000 diagnostics. Non-removable hard maxima prevent callers from increasing these beyond 100,000 directories, 1,000,000 entries, 20,000 instruction files, 16 MiB per-file content, 64 MiB total content, or 5,000 diagnostics. Before building a Markdown AST, each instruction file is also limited to 10,000 lines and 50,000 Markdown syntax markers; the parsed tree is limited to 20,000 nodes.

Structured policy files are limited to 1 MiB each and 8 MiB per resolution. Readability input is limited to 4 MiB, 250,000 AST nodes, and 3,000,000 charged work units. Score JSON input is limited to 16 MiB; assessment evidence is additionally limited to 128 entries per array, 10,000 Unicode code points per text value, and 8 MiB aggregate UTF-8 text. Stable readers bind content to an opened descriptor and fail closed on replacement. On Darwin, configured waiver directories currently produce `WAIVER_DIRECTORY_UNSUPPORTED`/`INCOMPLETE` because Node.js does not expose safe descriptor-bound directory enumeration and the implementation does not fall back to pathname enumeration.

Score input uses the following shape excerpt; a runnable input must contain exactly one assessment for every minor item selected by the model. `model` and `baseline` are optional. A baseline repeats the same `model`/`assessments`/`context` contract and is calculated before comparison.

```json
{
  "schemaVersion": "1",
  "assessments": [],
  "context": { "scope": "repository", "gate": "PASS" }
}
```

## Local Verification

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:coverage
corepack pnpm build
corepack pnpm check
corepack pnpm benchmark
corepack pnpm check:progress
corepack pnpm check:release
```

`test:coverage` uses an offline Vitest custom provider backed by Node.js V8
precise function coverage. It reports loaded runtime modules and observed
functions, but deliberately does not claim source-map-remapped line or branch
coverage. Critical changed branches still require explicit behavior tests.

`check:release` is strict: registry-backed dependency audit failures are not
converted to warnings. It also runs the benchmark, secret scan, progress-matrix
validation, coverage suite, and `git diff --check`.

## Operational notes

- Progress is measured against the 19 approved acceptance criteria, not file
  presence. The current evidence matrix is 18 Complete and 1 Partial, or 97.4%;
  the remaining partial item is the network-backed dependency audit. See
  [`docs/PROGRESS.md`](docs/PROGRESS.md).
- Review path now collects bounded file context, uses single-flight cache/locks, enforces egress by data classification, verifies blocking findings with path-linked evidence, and emits score assessments + `ScoreGate`.
- Forge PR/MR review: API metadata + optional bare-repo cache / disposable worktrees; **active policy is bound to the base revision**, and head-side profile/AGENTS changes are ignored.
- Publication is explicit: `cq review --forge-url <url> --publish --yes` with `CQ_FORGE_TOKEN`.
- Integrations: `cq integrations install --target project|codex|claude [--confirm]`.
- Run-checks: `--run-checks-preview` / `--run-checks`; failed checks force incomplete and block publish.
- CI templates stay under `templates/ci/`; install with `cq ci install --target github|gitlab --confirm` after ops review (this package does not auto-enable workflows).
- Shared path placement: `CQ_SHARED_STATE_DIR`, `CQ_SHARED_LOCK_DIR`, and `CQ_SHARED_CACHE_DIR` change storage locations only; they do not provide cross-machine fencing. Single-flight admits at most 64 waiters per key per local host for at most 60 seconds. Cross-machine coordination remains unsupported.
- Live provider/forge soak: `cq providers validate --live` (or `CQ_PROVIDER_LIVE_SOAK=1`); never sends repository source content.
- Transcript retention: `cq review ... --retain-transcript` (redacted, mode 0600, run marked sensitive).

See [the CLI design](docs/superpowers/specs/2026-07-19-code-quality-cli-design.md) for the approved target architecture and [AGENTS.md](AGENTS.md) for the canonical repository rules.
