---
name: code-quality-review
description: >
  Run the code-quality CLI for evidence-driven reviews. Use when asked to
  review code, gate a commit/push, inspect readability, validate agent docs,
  or score assessments with cq.
---

# Code Quality Review Skill

## When to use

- Production code review for behavior, readability, concurrency, and safety.
- Pre-commit or pre-push quality gates through the shared CLI.
- Agent-instruction validation with `cq validate`.

## Source of truth

- Shared rules live in repository or global `AGENTS.md`.
- Detailed standards live in `docs/standards/*`.
- Machine policy lives in CLI schemas, profiles, and rules — do not copy them
  into this Skill.

## Preferred commands

```bash
cq validate
cq rules list
cq inspect readability <file>
cq score <assessment.json>
cq review --staged
cq review --worktree
cq review --repository --preflight
cq review --repository --confirm-full-repository <hash>
cq report <run-id>
cq runs
```

## Authorization boundaries

- Default is analysis only. Do not modify production code unless the user asks.
- Full-repository reviews require preflight plus hash confirmation.
- Publication is opt-in and requires independent confirmation.
- Never commit, push, install hooks, or install global integrations without an
  explicit current-conversation authorization.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Completed without blocking findings |
| 1 | Confirmed blocking finding |
| 2 | Invalid input or configuration |
| 3 | Incomplete review |
| 4 | Publication failure |

## Host notes

See `references/codex.md` and `references/claude-code.md` for host-specific
invocation notes. Keep host deltas tiny; route shared policy back to `AGENTS.md`.
