# Agent Instructions Foundation Implementation Plan

> **For agentic workers:** Execute this plan inline and verify each task before moving on. Git commits are prohibited unless the user separately authorizes them in the current conversation.

**Goal:** Make `AGENTS.md` the concise canonical shared instruction source, move detailed review knowledge into routed standards and playbooks, and ensure peer Agent instruction files reuse `AGENTS.md` instead of copying shared rules.

**Architecture:** The root `AGENTS.md` owns non-removable authorization, safety, gate, readability, concurrency, scoring, and routing rules. Detailed review criteria live in focused documents under `docs/standards/`; repeatable workflows live under `docs/playbooks/`; report shape lives under `templates/`. `CLAUDE.md` and `GEMINI.md` contain only a mandatory pointer to `AGENTS.md` and a tool-specific delta section.

**Tech Stack:** Markdown, Git, shell-based structural verification.

---

### Task 1: Establish the focused documentation map

**Files:**
- Create: `docs/standards/severity-and-findings.md`
- Create: `docs/standards/readability.md`
- Create: `docs/standards/universal-gates.md`
- Create: `docs/standards/concurrency.md`
- Create: `docs/standards/security.md`
- Create: `docs/standards/testing-and-automation.md`
- Create: `docs/standards/scoring.md`
- Create: `docs/playbooks/review-process.md`
- Create: `docs/playbooks/continuous-improvement.md`
- Create: `templates/review-report.md`

- [x] Move every detailed rule from the current `AGENTS.md` into exactly one focused owner document.
- [x] Preserve P0-P3/NIT meanings, evidence requirements, risk triggers, review output, automation boundaries, baseline ratchets, and incident-to-rule lifecycle.
- [x] Add the approved `CQ-READ-001` through `CQ-READ-008` readability rules and diff-aware hotspot thresholds.
- [x] Add the approved 100.0-point scoring dimensions, all minor items, one-decimal output, applicability coverage, model versions, and independent gates.
- [x] Define `CQ-AGENT-001` as a cross-repository validation item, including orphan peer scopes, canonical pointers, exact copied policy, conflicts, cycles, and warn-to-block ratcheting.
- [x] Keep documents explicit about current versus planned CLI behavior.

Verification:

```bash
rg -n '^# ' docs/standards docs/playbooks templates/review-report.md
rg -n 'CQ-READ-00[1-8]' docs/standards/readability.md
rg -n '100\.0|one decimal|一位小数|门禁' docs/standards/scoring.md
```

Expected: every file has one top-level heading, all eight readability rule IDs exist, and scoring documents the 100.0-point model and independent gate rule.

### Task 2: Rewrite the canonical root AGENTS.md

**Files:**
- Modify: `AGENTS.md`

- [x] Retain Git authority, instruction priority, analysis-versus-modification boundary, dirty-worktree protection, evidence, high-concurrency requirements, secret handling, and external-side-effect authorization.
- [x] Declare `AGENTS.md` the canonical shared instruction source for peer Agent files.
- [x] Add the CLI/Skill/AGENTS source-of-truth boundary without claiming the planned CLI already exists.
- [x] State the independent adoption model: global Agent routing or Codex/Claude Code Skills invoke an Agent-neutral CLI, project profiles configure local policy, and Git Hooks provide an explicit commit-time fallback.
- [x] Add the mandatory review lifecycle, readability priority, 100.0-point score summary, independent gate rule, and document routing table.
- [x] Remove detailed checklists that now have focused owner documents.
- [x] Keep the root file concise enough to serve as a daily instruction router.

Verification:

```bash
wc -l AGENTS.md
rg -n 'git commit|高并发|CQ-READ|100\.0|docs/standards|docs/playbooks|CLAUDE\.md|GEMINI\.md' AGENTS.md
```

Expected: the root file is substantially shorter than 905 lines and retains every critical category and route.

### Task 3: Add peer Agent instruction pointers

**Files:**
- Create: `CLAUDE.md`
- Create: `GEMINI.md`

- [x] Each file requires the Agent to read and follow `AGENTS.md` in full before acting.
- [x] Each file states that shared rules must not be copied into the peer file.
- [x] Each file reserves a clearly named tool-specific delta section and states that it cannot weaken `AGENTS.md`.
- [x] Do not add tool-specific deltas when none are currently required.
- [x] Treat both files as local compliance examples for the planned `CQ-AGENT-001` validator.

Verification:

```bash
rg -n 'AGENTS\.md|shared|共性|specific|特定' CLAUDE.md GEMINI.md
cmp <(sed 's/Claude/Gemini/g' CLAUDE.md) GEMINI.md
```

Expected: both files point to the canonical file and differ only in Agent name.

### Task 4: Verify preservation, routing, and workspace safety

**Files:**
- Verify all files created or modified in Tasks 1-3.

- [x] Check Markdown whitespace and links.
- [x] Confirm the original major subjects still appear in either root or routed documents.
- [x] Confirm planned commands are labeled planned and no unavailable CLI is presented as current functionality.
- [x] Confirm no unrelated workspace content was modified.
- [x] Review the final diff and report untracked unrelated files separately.

Verification:

```bash
git diff --check
rg -n 'P0|P1|P2|P3|NIT' AGENTS.md docs/standards/severity-and-findings.md
rg -n 'Hot path amplification|Race|Lock|Single-flight|Background|Multi-instance|Resource' AGENTS.md docs/standards/concurrency.md
rg -n 'planned|规划|尚未实现|当前状态' AGENTS.md docs/standards/testing-and-automation.md
git status --short
```

Expected: no whitespace errors; severity and all seven concurrency dimensions are preserved; future CLI behavior is not presented as already shipped; only intended files plus pre-existing unrelated files appear.
