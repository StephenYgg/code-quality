#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync(
  "corepack",
  ["pnpm", "audit", "--prod", "--audit-level", "high"],
  { stdio: "inherit", shell: false },
);
if (result.error) {
  console.error("check-dependencies: pnpm audit could not start");
  process.exitCode = 1;
} else {
  process.exitCode = result.status === 0 ? 0 : 1;
}
