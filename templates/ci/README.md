# Inactive CI templates

These workflow templates are intentionally outside `.github/workflows` and
`.gitlab-ci.yml` so the package does not auto-enable privileged automation.

Before enabling:

1. Review least-privilege token requirements with operations.
2. Pin action/image digests for production use.
3. Keep production credentials out of review jobs.
4. Use the documented check names: `format:check`, `lint`, `typecheck`, `test`,
   `build`, `check:dependencies`, `check:secrets`.
