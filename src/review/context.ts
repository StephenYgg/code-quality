import { TextDecoder } from "node:util";

import type { ReviewSnapshot } from "../core/snapshots.js";

export const MAX_CONTEXT_FILES = 40;
export const MAX_CONTEXT_FILE_BYTES = 64 * 1024;
export const MAX_CONTEXT_TOTAL_BYTES = 512 * 1024;

export interface ContextFile {
  readonly path: string;
  readonly content: string;
  readonly byteLength: number;
  readonly truncated: boolean;
}

export interface ReviewContextBundle {
  readonly files: readonly ContextFile[];
  readonly totalBytes: number;
  readonly incomplete: boolean;
  readonly exclusions: readonly string[];
}

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function collectReviewContext(
  snapshot: ReviewSnapshot,
  options?: {
    readonly contentByPath?: ReadonlyMap<string, Buffer>;
    readonly maxFiles?: number;
    readonly maxFileBytes?: number;
    readonly maxTotalBytes?: number;
  },
): Promise<ReviewContextBundle> {
  const maxFiles = options?.maxFiles ?? MAX_CONTEXT_FILES;
  const maxFileBytes = options?.maxFileBytes ?? MAX_CONTEXT_FILE_BYTES;
  const maxTotalBytes = options?.maxTotalBytes ?? MAX_CONTEXT_TOTAL_BYTES;
  const selected = snapshot.files
    .filter((file) => file.status !== "deleted" && !file.binary)
    .slice(0, maxFiles);

  const files: ContextFile[] = [];
  const exclusions: string[] = [];
  let totalBytes = 0;
  let incomplete =
    snapshot.incomplete || snapshot.files.length > selected.length;

  for (const file of selected) {
    if (totalBytes >= maxTotalBytes) {
      incomplete = true;
      exclusions.push(file.path);
      continue;
    }
    const remaining = maxTotalBytes - totalBytes;
    const limit = Math.min(maxFileBytes, remaining);
    const bytes = options?.contentByPath?.get(file.path);
    if (bytes === undefined) {
      incomplete = true;
      exclusions.push(file.path);
      continue;
    }
    const truncated = bytes.length > limit;
    const slice = truncated ? bytes.subarray(0, limit) : bytes;
    let content: string;
    try {
      content = fatalUtf8Decoder.decode(slice);
    } catch {
      incomplete = true;
      exclusions.push(file.path);
      continue;
    }
    files.push({
      path: file.path,
      content,
      byteLength: slice.length,
      truncated,
    });
    totalBytes += slice.length;
    if (truncated) incomplete = true;
  }

  return Promise.resolve(
    Object.freeze({
      files: Object.freeze(files),
      totalBytes,
      incomplete,
      exclusions: Object.freeze(exclusions),
    }),
  );
}

export function contextToPromptSections(
  context: ReviewContextBundle,
): readonly {
  readonly role: "untrusted";
  readonly label: string;
  readonly text: string;
}[] {
  return context.files.map((file) => ({
    role: "untrusted" as const,
    label: `BEGIN_UNTRUSTED_FILE:${file.path}${file.truncated ? ":TRUNCATED" : ""}`,
    text: file.content,
  }));
}
