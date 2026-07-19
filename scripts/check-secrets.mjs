#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 256 * 1024;
const SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  ".cq-git-view-",
  "coverage",
]);
const SKIP_PATH_MARKERS = [
  `${sep}tests${sep}`,
  `${sep}benchmarks${sep}`,
  `${sep}templates${sep}`,
];
const PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}/i,
  /ghp_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
];

async function walk(directory, files) {
  if (files.length >= MAX_FILES) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (SKIP.has(entry.name) || entry.name.startsWith(".cq-git-view-")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path, files);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(path);
  }
}

const files = [];
await walk(ROOT, files);
let findings = 0;
for (const file of files) {
  const relativePath = relative(ROOT, file);
  const normalized = `${sep}${relativePath.split(/[\\/]/u).join(sep)}${sep}`;
  if (SKIP_PATH_MARKERS.some((marker) => normalized.includes(marker))) {
    continue;
  }
  const info = await stat(file);
  if (info.size > MAX_FILE_BYTES) continue;
  const text = await readFile(file, "utf8");
  for (const pattern of PATTERNS) {
    if (pattern.test(text)) {
      findings += 1;
      console.error(`possible secret: ${relativePath}`);
      break;
    }
  }
}
if (findings > 0) {
  console.error(`check-secrets: ${findings} potential secret finding(s)`);
  process.exitCode = 1;
} else {
  console.log("check-secrets: ok");
}
