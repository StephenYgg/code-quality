# Code Quality

Code Quality is an evidence-driven, incremental code review system. The first-release CLI foundation is runnable: deterministic policy/scoring/readability, local Git snapshots, full-repository preflight, provider adapters, review orchestration, forge URL readers, hooks, skills, and inactive CI templates.

## Current Capability

The CLI currently provides:

- `cq validate [repository]`: aggregates `CQ-AGENT-001` with strict profile, rule-pack, schema, provider-selection, and waiver validation without invoking a model;
- `cq rules list` and `cq rules explain <rule-id>`: inspect the effective deterministic rule catalog;
- `cq inspect readability <file>`: run bounded TypeScript/JavaScript AST analysis for `CQ-READ-001` through `CQ-READ-008` candidates;
- `cq score <input.json>`: calculate the versioned 100.0-point model from validated assessments, including focused-domain and baseline-delta results;
- `cq review --worktree|--staged|--commit|--range|--repository|--forge-url`: capture immutable inputs and run bounded review orchestration (provider required except repository `--preflight`);
- `cq review --repository --preflight` and `--confirm-full-repository <hash>`: full-repository manifest confirmation without inferring scope;
- `cq report <run-id>` and `cq runs`: render and list stored sanitized run records;
- `cq init [--confirm]`: plan or create `.code-quality/profile.yaml` without replacing `AGENTS.md`;
- `cq hooks install|status|uninstall`: optional managed local Git hooks.

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
node dist/cli.js runs
node dist/cli.js hooks status
```

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
corepack pnpm build
corepack pnpm check
```

## Remaining Hardening

Implemented but still incremental versus the full design:

- Forge readers resolve PR/MR metadata; they do not yet materialize full immutable file bodies from bare caches.
- Publication helpers exist (`src/forges/publish.ts`) but are not a complete live publish command path.
- Provider adapters are covered by fake CLI and local HTTP tests; real host CLI flags still need production soak.
- Global Agent integration installers remain partial relative to the full managed-block installer plan.
- Secrets/dependency scripts are local (`pnpm run check:secrets`, `pnpm run check:dependencies`); CI templates stay inactive under `templates/ci/`.

See [the CLI design](docs/superpowers/specs/2026-07-19-code-quality-cli-design.md) for the approved target architecture and [AGENTS.md](AGENTS.md) for the canonical repository rules.
