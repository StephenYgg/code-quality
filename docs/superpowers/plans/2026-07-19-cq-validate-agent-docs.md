# CQ Validate Agent Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first runnable TypeScript CLI slice: `cq validate` performs bounded, read-only `CQ-AGENT-001` validation for canonical `AGENTS.md` reuse and emits terminal or JSON evidence.

**Architecture:** A filesystem discovery module enumerates canonical and peer Agent instruction files into directory scopes without following directory symlinks. A separate validator reads bounded content, parses Markdown references, detects deterministic policy violations, and returns a typed report. The Commander entry point only translates arguments and renders the report; it does not own validation policy.

**Tech Stack:** Node.js 22+, TypeScript strict ESM, pnpm, Commander, `mdast-util-from-markdown`, Vitest, ESLint, Prettier.

**Authorization:** Do not commit, push, publish, install hooks, or modify user-level Agent configuration. The current workspace remains on `main` because the approved untracked design documents cannot be moved to an isolated worktree without creating a prohibited commit.

---

## File Map

- `package.json`: package metadata, `cq` / `code-quality` binaries, and local quality commands.
- `tsconfig.json`: strict editor and test typechecking configuration.
- `tsconfig.build.json`: production build boundary from `src/` to `dist/`.
- `eslint.config.js`: type-aware TypeScript linting with generated and unrelated directories ignored.
- `.prettierignore`: excludes generated output and the pre-existing unrelated `.obsidian/` tree.
- `.gitignore`: excludes only generated package, build, coverage, and CLI runtime output.
- `src/core/agent-diagnostic.ts`: constructs diagnostics without leaking parser-only evidence fields.
- `src/core/bounded-diagnostics.ts`: retains deterministic diagnostics within the configured total, including the truncation sentinel.
- `src/core/bounded-selection.ts`: shared bounded max-heap selection used by discovery and diagnostic retention.
- `src/core/validation.ts`: shared Gate, diagnostic, and report contracts.
- `src/instructions/discovery.ts`: bounded filesystem discovery and directory-scope construction.
- `src/instructions/markdown.ts`: preflight-bounded Markdown AST reference, section, and normalized-block extraction.
- `src/instructions/reference-graph.ts`: iterative cycle detection without call-stack growth.
- `src/instructions/bounded-reader.ts`: regular-file, containment, TOCTOU, and byte-budget enforcement.
- `src/instructions/reuse-validator.ts`: `CQ-AGENT-001` policy and report aggregation.
- `src/reporters/validation-json.ts`: stable JSON serialization.
- `src/reporters/validation-terminal.ts`: concise human-readable validation output.
- `src/reporters/terminal-safe.ts`: control-character escaping and UTF-8 field limits.
- `src/commands/validate.ts`: validates arguments and invokes the instruction validator.
- `src/cli.ts`: Commander wiring and process exit mapping.
- `tests/unit/instructions/bounded-reader.test.ts`: positioned short-read completion behavior.
- `tests/unit/instructions/discovery.test.ts`: scope discovery and resource-bound behavior.
- `tests/unit/instructions/reuse-validator.test.ts`: deterministic rule behavior and false-positive protection.
- `tests/unit/reporters/validation-reporters.test.ts`: stable terminal and JSON output.
- `tests/integration/cli-validate.test.ts`: public command behavior and exit codes.
- `README.md`: truthful current capability, usage, status, and limitations.

## Task 1: Establish the TypeScript Package and Test Harness

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `eslint.config.js`
- Create: `.prettierignore`
- Create: `.gitignore`

- [x] **Step 1: Create package metadata and scripts**

Use a private ESM package with `packageManager: pnpm@11.7.0`, `engines.node: >=22`, and both binaries pointing to `dist/cli.js`. Add these scripts exactly:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "check": "corepack pnpm format:check && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build",
    "format": "prettier --write \"src/**/*.ts\" \"tests/**/*.ts\" \"*.{json,js}\"",
    "format:check": "prettier --check \"src/**/*.ts\" \"tests/**/*.ts\" \"*.{json,js}\"",
    "lint": "eslint .",
    "test": "vitest run",
    "test:integration": "vitest run tests/integration",
    "test:unit": "vitest run tests/unit",
    "typecheck": "tsc --noEmit"
  }
}
```

Runtime dependencies are `commander` and `mdast-util-from-markdown`. Development dependencies are `@eslint/js`, `@types/mdast`, `@types/node`, `eslint`, `prettier`, `typescript`, `typescript-eslint`, and `vitest`.

- [x] **Step 2: Configure strict ESM compilation**

Use `module` and `moduleResolution` `NodeNext`, `target` `ES2022`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `verbatimModuleSyntax: true`, and `skipLibCheck: true`. The base TypeScript config includes `src` and `tests`; `eslint.config.js` is checked by ESLint and Prettier. The build config includes only `src`, writes declarations and source maps to `dist`, and excludes tests.

- [x] **Step 3: Configure lint, formatting exclusions, and generated files**

ESLint must apply `@eslint/js` recommended rules and `typescript-eslint` strict type-checked rules to TypeScript files, with project service enabled. Ignore `.obsidian/`, `dist/`, `coverage/`, and `node_modules/`. `.prettierignore` must ignore those same directories. `.gitignore` must ignore `node_modules/`, `dist/`, `coverage/`, and `.code-quality/cache/` / `.code-quality/runs/`, but must not hide the unrelated `.obsidian/` directory from Git status.

- [x] **Step 4: Install dependencies and prove the harness starts empty**

Run:

```bash
corepack pnpm install
corepack pnpm exec vitest run --passWithNoTests
```

Expected: dependency installation succeeds and Vitest exits 0 while reporting no tests. Do not claim the feature exists at this checkpoint.

## Task 2: Discover Instruction Scopes with Hard Resource Bounds

**Files:**

- Create: `tests/unit/instructions/discovery.test.ts`
- Create: `src/core/validation.ts`
- Create: `src/instructions/discovery.ts`

- [x] **Step 1: Write failing discovery tests**

Tests create temporary repositories with `mkdtemp` and assert these behaviors independently:

```typescript
test('groups canonical and peer files by repository-relative directory', async () => {
  // root AGENTS.md + CLAUDE.md, packages/api AGENTS.md + GEMINI.md
  // Expect two sorted scopes with POSIX relative paths.
});

test('reports a peer-only directory as an orphan scope', async () => {
  // nested/CLAUDE.md exists without nested/AGENTS.md.
  // Expect the nested scope to exist with canonical undefined.
});

test('does not descend into directory symlinks or generated directories', async () => {
  // A symlinked directory and node_modules contain instruction filenames.
  // Expect neither to be discovered.
});

test('accepts safe configured peer basenames and rejects paths', async () => {
  // QWEN.md is discovered when configured; ../CLAUDE.md is rejected.
});

test('stops with an incomplete discovery issue when a hard limit is exceeded', async () => {
  // maxDirectories: 1 with a nested directory.
  // Expect LIMIT_EXCEEDED and no silent partial-success claim.
});
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
corepack pnpm exec vitest run tests/unit/instructions/discovery.test.ts
```

Expected: FAIL because `src/instructions/discovery.ts` and its exports do not exist.

- [x] **Step 3: Implement the typed contracts and discovery API**

Export these stable shapes:

```typescript
export type ValidationGate = 'PASS' | 'WARN' | 'BLOCK' | 'INCOMPLETE';
export type DiagnosticCertainty = 'deterministic' | 'review_required';

export interface ValidationDiagnostic {
  readonly ruleId: 'CQ-AGENT-001';
  readonly code: string;
  readonly certainty: DiagnosticCertainty;
  readonly category: 'policy' | 'incomplete';
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly relatedPath?: string;
  readonly message: string;
}

export interface InstructionFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly name: string;
  readonly symbolicLink: boolean;
}

export interface InstructionScope {
  readonly directory: string;
  readonly canonical?: InstructionFile;
  readonly peers: readonly InstructionFile[];
}

export interface DiscoveryOptions {
  readonly peerFileNames?: readonly string[];
  readonly maxDirectories?: number;
  readonly maxInstructionFiles?: number;
  readonly maxEntries?: number;
  readonly maxDiagnostics?: number;
}

export interface DiscoveryResult {
  readonly repository: string;
  readonly scopes: readonly InstructionScope[];
  readonly diagnostics: readonly ValidationDiagnostic[];
}
```

`discoverInstructionScopes(repository, options)` must resolve and verify a directory root, stream entries sequentially with `opendir`, and use bounded selection to process retained directories and instruction files in deterministic repository-relative order before applying their limits. It skips `.git`, `node_modules`, `dist`, `coverage`, and `.code-quality/cache`, never follows directory symlinks, and includes matching file symlinks for later validation. Default peer names are `CLAUDE.md` and `GEMINI.md`; configured names must be safe basenames ending in `.md`, must not equal `AGENTS.md`, and are deduplicated.

Default limits are 20,000 directories, 200,000 streamed directory entries, and 5,000 instruction files. Non-removable hard maxima are 100,000 directories, 1,000,000 entries, and 20,000 instruction files. Directory and instruction-file limits retain the deterministic lexicographically first bounded subset. Entry-limit exhaustion returns `INCOMPLETE` and discards partial scope evidence because unread entries cannot participate in deterministic ordering. Other limit or read failures retain bounded evidence already collected. All exposed paths are repository-relative POSIX paths; the root directory is `.`.

- [x] **Step 4: Run discovery tests and verify GREEN**

Run the same targeted Vitest command. Expected: all discovery tests PASS.

## Task 3: Implement `CQ-AGENT-001` with Structured Markdown Evidence

**Files:**

- Create: `tests/unit/instructions/reuse-validator.test.ts`
- Create: `src/instructions/markdown.ts`
- Create: `src/instructions/reuse-validator.ts`

- [x] **Step 1: Write failing policy tests**

Create one focused test for each behavior:

```typescript
test('accepts a minimal Markdown pointer with an empty tool-specific delta');
test('accepts a peer symlink that resolves to the same-scope AGENTS.md');
test('warns when a peer scope has no same-directory AGENTS.md');
test('warns when a peer does not reference AGENTS.md');
test('warns when the only pointer targets a parent AGENTS.md');
test('warns when a normalized nontrivial policy block is copied from AGENTS.md');
test('warns on an explicit instruction to ignore or override AGENTS.md');
test('warns when peer Markdown links form a reference cycle');
test('returns INCOMPLETE for broken symlinks, unreadable files, or byte limits');
test('does not flag a short canonical pointer as copied shared policy');
test('uses configured peer filenames without requiring optional peers to exist');
```

The compliant pointer fixture must match the actual repository convention:

```markdown
# Claude Agent Instructions

## Canonical Instructions

Before taking any action, read the sibling `AGENTS.md` in full and comply with it.

## Tool-Specific Delta

None.
```

- [x] **Step 2: Run the validator tests and verify RED**

Run:

```bash
corepack pnpm exec vitest run tests/unit/instructions/reuse-validator.test.ts
```

Expected: FAIL because the Markdown and reuse-validator modules do not exist.

- [x] **Step 3: Implement Markdown extraction without regex-only parsing**

`parseInstructionMarkdown(source)` must use `fromMarkdown()` and return:

```typescript
export interface ParsedInstructionMarkdown {
  readonly references: readonly string[];
  readonly headings: readonly string[];
  readonly normalizedBlocks: readonly string[];
  readonly explicitCanonicalConflict: boolean;
}
```

Before parsing, reject sources exceeding 10,000 lines or 50,000 Markdown syntax markers. Traverse at most 20,000 MDAST nodes to collect Markdown link URLs, recursively nested reference definitions, exact inline-code filenames, headings, and paragraph/list-item text. Normalize blocks with Unicode-aware whitespace collapse and case folding, retaining only blocks of at least 120 normalized characters for copy comparison. Detect explicit conflict only when the same sentence or block both names `AGENTS.md` and uses a narrow deny/override phrase such as `ignore`, `do not follow`, `override`, `忽略`, `无需遵守`, or `覆盖`. Semantic similarity outside this provable set is not a deterministic violation. Any Markdown preflight or AST bound produces `MARKDOWN_LIMIT_EXCEEDED` and Gate `INCOMPLETE`.

- [x] **Step 4: Implement the bounded reuse validator**

Export:

```typescript
export interface ValidateAgentInstructionsOptions extends DiscoveryOptions {
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxDiagnostics?: number;
}

export interface AgentInstructionValidationReport {
  readonly ruleId: 'CQ-AGENT-001';
  readonly gate: ValidationGate;
  readonly repository: string;
  readonly scopesChecked: number;
  readonly filesChecked: number;
  readonly diagnostics: readonly ValidationDiagnostic[];
}

export async function validateAgentInstructions(
  repository: string,
  options?: ValidateAgentInstructionsOptions,
): Promise<AgentInstructionValidationReport>;
```

Default maximums are 1 MiB per instruction file, 16 MiB total, and 1,000 diagnostics including any truncation sentinel. Read files sequentially and continue legal short reads until EOF or the bounded buffer is full. Reject real paths outside the repository. A peer symlink is compliant only when its real target equals the same-scope canonical real path. A Markdown peer is compliant only when it contains an exact same-scope reference (`AGENTS.md` or `./AGENTS.md`, optionally followed by sentence punctuation), binds both reading and following semantics to that canonical reference, has no explicit conflict, has no nontrivial normalized block copied from the canonical source, and does not participate in a relative-link cycle among discovered instruction files. Reference-cycle evidence must point to an edge within the same strongly connected component. Diagnostic locations contain only line and column, never source text or parser-only fields.

Use stable diagnostic codes: `ORPHAN_PEER_SCOPE`, `MISSING_CANONICAL_REFERENCE`, `MISSING_CANONICAL_DIRECTIVE`, `WRONG_CANONICAL_SCOPE`, `BROKEN_SYMLINK`, `SYMLINK_TARGET_MISMATCH`, `REFERENCE_CYCLE`, `COPIED_SHARED_POLICY`, `EXPLICIT_CANONICAL_CONFLICT`, `UNSCOPED_PEER_CONTENT`, `FILE_LIMIT_EXCEEDED`, `TOTAL_LIMIT_EXCEEDED`, `MARKDOWN_LIMIT_EXCEEDED`, `DIAGNOSTIC_LIMIT_EXCEEDED`, `READ_FAILED`, and discovery-originated `SCAN_LIMIT_EXCEEDED` / `SCAN_FAILED`.

Policy violations are advisory and produce Gate `WARN`. Resource or read failures make Gate `INCOMPLETE`. No result in this slice produces `BLOCK`; later profile ratcheting owns promotion. Sort diagnostics by path then code for stable output.

- [x] **Step 5: Run validator tests and verify GREEN**

Run the targeted test. Expected: all validator tests PASS with no warning output.

## Task 4: Expose Stable Terminal and JSON CLI Behavior

**Files:**

- Create: `tests/unit/reporters/validation-reporters.test.ts`
- Create: `tests/integration/cli-validate.test.ts`
- Create: `src/reporters/validation-json.ts`
- Create: `src/reporters/validation-terminal.ts`
- Create: `src/commands/validate.ts`
- Create: `src/cli.ts`

- [x] **Step 1: Write failing reporter and CLI tests**

Reporter tests require deterministic ordering and assert:

```text
Gate: WARN
Rule: CQ-AGENT-001
Repository: <absolute path>
Scopes checked: 1
Files checked: 1
Diagnostics: 1
[WARN] ORPHAN_PEER_SCOPE nested/CLAUDE.md
```

JSON output must parse to the report shape without ANSI text. CLI integration tests call exported `runCli(args, io)` with in-memory stdout/stderr and assert:

- `validate <compliant-repo>` returns exit 0 and terminal Gate `PASS`.
- `validate <orphan-repo>` returns exit 0 and terminal Gate `WARN`.
- `validate <orphan-repo> --format json` returns exit 0 and parseable JSON.
- `validate <missing-path>` returns exit 2, writes only a bounded diagnostic to stderr, and does not include a stack trace.
- no command or `--help` performs repository validation or writes files.

- [x] **Step 2: Run reporter and integration tests and verify RED**

Run:

```bash
corepack pnpm exec vitest run tests/unit/reporters/validation-reporters.test.ts tests/integration/cli-validate.test.ts
```

Expected: FAIL because reporters and CLI entry points do not exist.

- [x] **Step 3: Implement pure reporters**

`renderValidationJson(report)` returns `JSON.stringify(report, null, 2) + '\n'`. `renderValidationTerminal(report)` emits the stable header above, maps policy diagnostics to `[WARN]`, maps incomplete diagnostics to `[INCOMPLETE]`, includes `relatedPath` when present, and appends the escaped one-line message. It must never emit file contents.

- [x] **Step 4: Implement Commander wiring and exit mapping**

Export an injected interface and runner:

```typescript
export interface CliIo {
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export async function runCli(
  argv: readonly string[],
  io?: CliIo,
): Promise<number>;
```

The `validate [repository]` command defaults to `.`, supports `--format <terminal|json>`, and calls only `validateAgentInstructions`. Configure Commander not to terminate the process during tests. Exit mapping is `0` for `PASS` and advisory `WARN`, `1` for future `BLOCK`, `2` for invalid input/configuration, and `3` for `INCOMPLETE`. The executable path sets `process.exitCode` from `runCli(process.argv.slice(2))`; it never calls `process.exit()`.

- [x] **Step 5: Run reporter and CLI tests and verify GREEN**

Run the targeted command. Expected: all reporter and integration tests PASS.

## Task 5: Document and Verify the Runnable Slice

**Files:**

- Create: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/standards/testing-and-automation.md`
- Modify: `docs/superpowers/specs/2026-07-19-code-quality-cli-design.md`
- Modify: this plan checklist only as work completes.

- [x] **Step 1: Write truthful capability documentation**

README must say the project is an early executable slice, show `corepack pnpm install`, `corepack pnpm build`, and `node dist/cli.js validate <repository>`, document Gate and exit semantics, and list the currently implemented `CQ-AGENT-001` evidence. It must explicitly state that model providers, PR/MR input, scoring, integrations, hooks, publication, and CI are not yet implemented.

Update current-state statements so only `cq validate` and `CQ-AGENT-001` are marked runnable. Keep all other commands and integrations labeled planned. Do not claim a globally installed `cq` binary unless package installation has actually been performed.

- [x] **Step 2: Run focused and full verification**

Run fresh commands:

```bash
corepack pnpm format
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
node dist/cli.js validate .
node dist/cli.js validate . --format json
git diff --check
git status --short
```

Expected: formatting, lint, typecheck, all tests, build, and whitespace checks exit 0. Validation of this repository returns Gate `PASS`, proving `CLAUDE.md` and `GEMINI.md` satisfy the implemented rule. Status may still show the pre-existing unrelated `.obsidian/`; no file inside it may be modified.

- [x] **Step 3: Perform the mandatory concurrency and security review**

Record in the handoff:

- Hot path amplification: one local invocation performs one bounded sequential directory scan and reads only recognized instruction files.
- Race / TOCTOU: repository files can change during a local scan; read/stat failures produce `INCOMPLETE`, and the result is not claimed as an immutable Git snapshot.
- Lock contention and single-flight: not applicable because this slice creates no shared cache, lock, task, provider call, or external side effect.
- Background bounds: no background work; directory count, entry count, instruction-file count, per-file bytes, total bytes, diagnostics, Markdown lines/markers, and AST nodes have hard limits.
- Multi-instance: invocations are independent and read-only, so duplicate execution has no shared side effect.
- Resource estimate: default worst-case is 20,000 directories, 200,000 entries, 5,000 instruction files, 1 MiB per file, 16 MiB total read content, and 1,000 diagnostics; each parsed file is capped at 10,000 lines, 50,000 Markdown markers, and 20,000 AST nodes. Non-removable hard maxima are documented in README.
- Security: directory symlinks are not followed, peer symlinks must resolve inside the repository to same-scope canonical files, target code is never executed, and output never includes instruction contents.

- [x] **Step 4: Review without committing**

Review every changed and untracked intended file. Confirm there is no commit, push, PR, Hook, global Agent modification, or unrelated `.obsidian/` change. Report that the increment is ready for user review but leave all changes uncommitted.
