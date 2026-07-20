# CI templates (activation requires ops approval)

These workflow templates live under `templates/ci/` so the package does **not**
auto-enable privileged automation in this repository (design reservation).

## Install into a consumer repository

```bash
# Plan
node dist/cli.js ci status
node dist/cli.js ci install --target github
node dist/cli.js ci install --target gitlab

# Apply after ops review
node dist/cli.js ci install --target github --confirm
node dist/cli.js ci install --target gitlab --confirm
```

GitHub destination: `.github/workflows/code-quality.yml`
GitLab destination: `.gitlab-ci.code-quality.yml` (include from project CI)

## Before enabling as a required check

1. Review least-privilege token requirements with operations.
2. Verify the pinned GitHub action revisions. Bind the GitLab
   `code-quality-node22-locked` tag to an immutably provisioned Node.js 22
   runner; the template intentionally contains no mutable container tag.
3. Keep production credentials out of review jobs (no live provider keys).
4. The template runs `pnpm check:release`: progress-matrix validation, format,
   lint, typecheck, coverage, tests, build, benchmark, dependency audit, secret
   scan, and diff whitespace validation.
5. Branch protection / required status is configured outside this CLI.

## Shared path placement (optional)

These settings place state on a shared volume but do not provide cross-machine
fencing or a global single-flight guarantee:

```bash
export CQ_SHARED_STATE_DIR=/mnt/cq-shared
# or:
export CQ_SHARED_LOCK_DIR=/mnt/cq-shared/locks
export CQ_SHARED_CACHE_DIR=/mnt/cq-shared/cache/entries
```

Inspect with `cq storage`.

Within one local host, a key admits at most 64 waiters for at most 60 seconds.
Cross-machine coordination remains unsupported.
