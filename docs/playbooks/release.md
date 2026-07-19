# Release playbook

1. Run `corepack pnpm check`.
2. Run `corepack pnpm run check:secrets`.
3. Run `corepack pnpm run check:dependencies` when network policy allows.
4. Build with `corepack pnpm build`.
5. Smoke the CLI: `node dist/cli.js --help`, `validate`, `rules list`,
   `review --repository --preflight`.
6. Confirm `package.json` `files` includes `dist`, `profiles`, `rules`,
   `schemas`, `skills`, `templates`, and docs needed at runtime.
7. Do not publish without an explicit human release decision.
