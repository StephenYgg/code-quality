#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";

const ROOT = await realpath(process.cwd());
const ALLOWLIST_PATH = "config/secret-scan-allowlist.json";
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const PATTERNS = [
  {
    id: "private-key",
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  },
  {
    id: "credential-assignment",
    expression:
      /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}/giu,
  },
  { id: "github-token", expression: /ghp_[A-Za-z0-9]{20,}/gu },
  { id: "openai-token", expression: /sk-[A-Za-z0-9]{20,}/gu },
];

class SecretScanError extends Error {
  constructor(message, code = "SCAN_FAILED") {
    super(message);
    this.code = code;
  }
}

try {
  const allowlist = await loadAllowlist();
  const paths = listReleasePaths();
  let totalBytes = 0;
  let findings = 0;
  for (const path of paths) {
    const content = await readStableFile(path, MAX_FILE_BYTES);
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new SecretScanError(
        `release content exceeds the ${MAX_TOTAL_BYTES.toString()} total scan byte limit`,
      );
    }
    const text = content.toString("utf8");
    for (const pattern of PATTERNS) {
      pattern.expression.lastIndex = 0;
      for (const match of text.matchAll(pattern.expression)) {
        if (isAllowed(allowlist, path, pattern.id, match[0])) continue;
        findings += 1;
        console.error(`possible secret: ${path} (${pattern.id})`);
      }
    }
  }
  if (findings > 0) {
    console.error(
      `check-secrets: ${findings.toString()} potential secret finding(s)`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `check-secrets: ok (${paths.length.toString()} files, ${totalBytes.toString()} bytes)`,
    );
  }
} catch (error) {
  console.error(
    `check-secrets: incomplete: ${error instanceof Error ? error.message : "unknown failure"}`,
  );
  process.exitCode = 1;
}

function listReleasePaths() {
  const listed = gitPaths([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const deleted = new Set(gitPaths(["ls-files", "-z", "--deleted"]));
  const paths = listed.filter((path) => !deleted.has(path)).sort();
  if (paths.length > MAX_FILES) {
    throw new SecretScanError(
      `release content exceeds the ${MAX_FILES.toString()} file scan limit`,
    );
  }
  if (new Set(paths).size !== paths.length || paths.some(invalidPath)) {
    throw new SecretScanError("Git returned an invalid release-file path");
  }
  return paths;
}

function gitPaths(args) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "buffer",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    shell: false,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      LANG: "C",
      LC_ALL: "C",
    },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new SecretScanError(
      "Git release-file enumeration failed or was truncated",
    );
  }
  const output = result.stdout;
  if (!Buffer.isBuffer(output) || output.length >= MAX_GIT_OUTPUT_BYTES) {
    throw new SecretScanError(
      "Git release-file enumeration exceeded its byte limit",
    );
  }
  return output
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

function invalidPath(path) {
  const candidate = join(ROOT, path);
  const relation = relative(ROOT, candidate);
  return (
    path.includes("\0") ||
    isAbsolute(path) ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  );
}

async function readStableFile(path, maximumBytes) {
  let handle;
  try {
    handle = await open(
      join(ROOT, path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new SecretScanError(`${path} is not a regular release file`);
    }
    if (before.size > BigInt(maximumBytes)) {
      throw new SecretScanError(
        `${path} exceeds the ${maximumBytes.toString()} scan byte limit`,
      );
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset > maximumBytes ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new SecretScanError(
        `${path} changed or exceeded limits during scan`,
      );
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof SecretScanError) throw error;
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new SecretScanError(`${path} does not exist`, "MISSING");
    }
    throw new SecretScanError(`${path} could not be read safely`);
  } finally {
    await handle?.close();
  }
}

async function loadAllowlist() {
  let content;
  try {
    content = await readStableFile(ALLOWLIST_PATH, MAX_FILE_BYTES);
  } catch (error) {
    if (error instanceof SecretScanError && error.code === "MISSING") {
      return [];
    }
    throw error;
  }
  let document;
  try {
    document = JSON.parse(content.toString("utf8"));
  } catch {
    throw new SecretScanError("secret allowlist is not valid JSON");
  }
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.schemaVersion !== "1" ||
    !Array.isArray(document.entries) ||
    Object.keys(document).some(
      (key) => key !== "schemaVersion" && key !== "entries",
    ) ||
    document.entries.length > 256
  ) {
    throw new SecretScanError("secret allowlist structure is invalid");
  }
  const entries = document.entries.map(validateAllowlistEntry);
  const keys = entries.map(
    (entry) => `${entry.path}\0${entry.patternId}\0${entry.matchSha256}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new SecretScanError("secret allowlist contains duplicate entries");
  }
  return entries;
}

function validateAllowlistEntry(entry) {
  const keys = [
    "path",
    "patternId",
    "matchSha256",
    "owner",
    "reason",
    "expiresAt",
  ];
  if (
    entry === null ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    Object.keys(entry).length !== keys.length ||
    keys.some((key) => !(key in entry)) ||
    typeof entry.path !== "string" ||
    invalidPath(entry.path) ||
    !PATTERNS.some(({ id }) => id === entry.patternId) ||
    !/^[a-f0-9]{64}$/u.test(entry.matchSha256) ||
    !boundedText(entry.owner, 128) ||
    !boundedText(entry.reason, 1024) ||
    !boundedText(entry.expiresAt, 64)
  ) {
    throw new SecretScanError("secret allowlist entry is invalid");
  }
  const expiry = Date.parse(entry.expiresAt);
  if (!Number.isFinite(expiry)) {
    throw new SecretScanError("secret allowlist expiry is invalid");
  }
  if (expiry <= Date.now()) {
    throw new SecretScanError(`expired allowlist entry for ${entry.path}`);
  }
  return entry;
}

function boundedText(value, maximumBytes) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function isAllowed(entries, path, patternId, match) {
  const matchSha256 = createHash("sha256").update(match).digest("hex");
  return entries.some(
    (entry) =>
      entry.path === path &&
      entry.patternId === patternId &&
      entry.matchSha256 === matchSha256,
  );
}
