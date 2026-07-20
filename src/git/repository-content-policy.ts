import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

import { compareCodeUnits } from "../core/deterministic-order.js";
import {
  MAX_SNAPSHOT_PATH_BYTES,
  type SnapshotExclusion,
  type SnapshotExclusionReason,
} from "../core/snapshots.js";

export const MAX_EXCLUSION_SAMPLES_PER_REASON = 20;

const DEPENDENCY_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  ".pnpm-store",
  "bower_components",
]);
const GENERATED_SEGMENTS = new Set([
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
]);
const CACHE_SEGMENTS = new Set([
  ".cache",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wasm",
  ".bin",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".jar",
  ".pyc",
]);
const SECRET_PATH_MARKERS = [
  ".env",
  "id_rsa",
  "id_ed25519",
  ".pem",
  ".p12",
  ".pfx",
  "credentials",
  "secrets",
];
const SECRET_CONTENT = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}/iu,
];
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function validatePath(path: string): string | undefined {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\0") ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    ) ||
    Buffer.byteLength(path, "utf8") > MAX_SNAPSHOT_PATH_BYTES
  ) {
    return undefined;
  }
  return path;
}

export function classifyRepositoryPath(
  path: string,
): SnapshotExclusionReason | undefined {
  const lower = path.toLowerCase();
  const segments = path.split("/");
  if (segments[0] === ".git" || segments.includes(".git")) {
    return "git_metadata";
  }
  if (segments.some((segment) => DEPENDENCY_SEGMENTS.has(segment))) {
    return "dependency";
  }
  if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) {
    return "generated";
  }
  if (segments.some((segment) => CACHE_SEGMENTS.has(segment))) return "cache";
  if (SECRET_PATH_MARKERS.some((marker) => lower.includes(marker))) {
    return "suspected_secret";
  }
  const extension = lower.includes(".")
    ? lower.slice(lower.lastIndexOf("."))
    : "";
  return BINARY_EXTENSIONS.has(extension) ? "binary" : undefined;
}

export function isBinaryContent(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

export function looksLikeSecret(buffer: Buffer): boolean {
  const text = buffer.toString("utf8");
  return SECRET_CONTENT.some((pattern) => pattern.test(text));
}

export function isValidUtf8(buffer: Buffer): boolean {
  try {
    fatalUtf8Decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export function pushExclusion(
  exclusions: SnapshotExclusion[],
  counts: Map<string, number>,
  samples: Map<string, number>,
  reason: SnapshotExclusionReason,
  path?: string,
  occurrences = 1,
): void {
  counts.set(reason, (counts.get(reason) ?? 0) + occurrences);
  const sampleCount = samples.get(reason) ?? 0;
  if (sampleCount < MAX_EXCLUSION_SAMPLES_PER_REASON) {
    exclusions.push(path === undefined ? { reason } : { reason, path });
    samples.set(reason, sampleCount + 1);
  }
}

export function exclusionCountRecord(
  counts: ReadonlyMap<string, number>,
): Readonly<Record<string, number>> {
  return Object.freeze(
    Object.fromEntries(
      [...counts].sort(([left], [right]) => compareCodeUnits(left, right)),
    ) as Record<string, number>,
  );
}
