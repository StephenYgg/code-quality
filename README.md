# Code Quality

Code Quality is an evidence-driven, incremental code review system. The project is in early implementation: the standards and first deterministic CLI validation rule are available, while model-backed review and delivery integrations are still being built.

## Current Capability

The first runnable slice implements `CQ-AGENT-001`, which validates that same-directory Agent instruction files reuse `AGENTS.md` as their canonical shared source.

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

The rule is advisory in this first slice. Policy findings produce `Gate: WARN`; incomplete scanning or reading produces `Gate: INCOMPLETE`.

## Build and Run

Prerequisites: Node.js 22 or a newer compatible release, plus Corepack.

```bash
corepack pnpm install
corepack pnpm build
node dist/cli.js validate /path/to/repository
node dist/cli.js validate /path/to/repository --format json
```

The package declares `cq` and `code-quality` binaries, but the commands above use the built entry point directly and do not assume a global installation.

Exit codes:

- `0`: `PASS` or advisory `WARN`;
- `1`: future blocking policy result;
- `2`: invalid input or configuration;
- `3`: `INCOMPLETE` validation.

Default validation limits are 20,000 directories, 200,000 total directory entries, 5,000 instruction files, 1 MiB per-file content, 16 MiB total content, and 1,000 diagnostics. Non-removable hard maxima prevent callers from increasing these beyond 100,000 directories, 1,000,000 entries, 20,000 instruction files, 16 MiB per-file content, 64 MiB total content, or 5,000 diagnostics. Before building a Markdown AST, each instruction file is also limited to 10,000 lines and 50,000 Markdown syntax markers; the parsed tree is limited to 20,000 nodes. Exceeding any Markdown limit produces `MARKDOWN_LIMIT_EXCEEDED` and `Gate: INCOMPLETE` rather than attempting an unbounded parse. The reader may consume one additional bounded detection byte to prove a content limit was exceeded; that byte is charged to the total read budget and never parsed as content.

## Local Verification

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm check
```

## Not Implemented Yet

The following approved design areas are not current capabilities:

- Codex, Claude, OpenAI-compatible, or Anthropic-compatible review providers;
- worktree, staged, commit, range, full-repository, GitHub PR, or GitLab MR review inputs and full-repository scope confirmation;
- readability AST analysis, full findings, scoring, profiles, schemas, and waivers;
- GitHub/GitLab publication;
- global Codex/Claude Code Skills and managed Agent integration installers;
- pre-commit/pre-push Hooks and CI templates.

See [the CLI design](docs/superpowers/specs/2026-07-19-code-quality-cli-design.md) for the approved target architecture and [AGENTS.md](AGENTS.md) for the canonical repository rules.
