import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { TextDecoder } from "node:util";

import { isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";

export const MAX_STRUCTURED_FILE_BYTES = 1024 * 1024;
export const MAX_RESOLUTION_BYTES = 8 * 1024 * 1024;
export const MAX_STRUCTURED_DEPTH = 64;

export interface StructuredReadBudget {
  bytesRead: number;
  readonly maximumBytes: number;
}

export interface StructuredSource {
  readonly source: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly data: unknown;
}

export interface LoadStructuredFileOptions {
  readonly containmentRoot: string;
  readonly source: string;
  readonly budget: StructuredReadBudget;
}

export interface StructuredFileIo {
  readonly open: (path: string, flags: number) => Promise<FileHandle>;
}

export interface StructuredFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
}

type StructuredReadOutcome =
  | { readonly ok: true; readonly value: StructuredSource }
  | { readonly ok: false; readonly error: StructuredConfigError };

export class StructuredConfigError extends Error {
  constructor(
    readonly code: string,
    readonly source: string,
    message: string,
    readonly path = "",
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = "StructuredConfigError";
  }
}

const DEFAULT_STRUCTURED_FILE_IO: StructuredFileIo = {
  open: async (path, flags) => open(path, flags),
};

export function createStructuredReadBudget(
  maximumBytes = MAX_RESOLUTION_BYTES,
): StructuredReadBudget {
  return { bytesRead: 0, maximumBytes };
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !isAbsolute(relation))
  );
}

function identity(stats: BigIntStats): StructuredFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    ctimeNs: stats.ctimeNs,
    mtimeNs: stats.mtimeNs,
  };
}

function sameIdentity(
  left: StructuredFileIdentity,
  right: StructuredFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

export async function captureStructuredIdentity(
  handle: FileHandle,
): Promise<StructuredFileIdentity> {
  const current = await handle.stat({ bigint: true });
  if (!current.isFile()) {
    throw new Error("Structured configuration is not a regular file");
  }
  return identity(current);
}

export async function verifyStructuredIdentity(
  requestedPath: string,
  resolvedPath: string,
  handle: FileHandle,
  expected: StructuredFileIdentity,
  source: string,
): Promise<void> {
  try {
    const descriptorIdentity = await captureStructuredIdentity(handle);
    const currentRealPath = await realpath(requestedPath);
    const pathnameStats = await stat(currentRealPath, { bigint: true });
    if (
      currentRealPath !== resolvedPath ||
      !pathnameStats.isFile() ||
      !sameIdentity(descriptorIdentity, expected) ||
      !sameIdentity(identity(pathnameStats), expected)
    ) {
      throw new Error("identity mismatch");
    }
  } catch {
    throw new StructuredConfigError(
      "CONFIG_CHANGED_DURING_READ",
      source,
      "Structured configuration changed during policy resolution",
    );
  }
}

async function readCompleteFile(
  handle: FileHandle,
  buffer: Buffer,
): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return offset;
}

function decodeUtf8(buffer: Buffer, source: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new StructuredConfigError(
      "CONFIG_INVALID_UTF8",
      source,
      "Structured configuration must be valid UTF-8",
    );
  }
}

function jsonErrorLocation(
  text: string,
  message: string,
): { readonly line?: number; readonly column?: number } {
  const match = /position (?<position>[0-9]+)/u.exec(message);
  const rawPosition = match?.groups?.position;
  if (rawPosition === undefined) {
    return { line: 1, column: 1 };
  }
  const position = Number(rawPosition);
  const prefix = text.slice(0, position);
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function offsetLocation(
  text: string,
  offset: number | undefined,
): { readonly line?: number; readonly column?: number } {
  if (offset === undefined) {
    return {};
  }
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function depthError(
  source: string,
  path: string,
  location: { readonly line?: number; readonly column?: number } = {},
): StructuredConfigError {
  return new StructuredConfigError(
    "CONFIG_DEPTH_EXCEEDED",
    source,
    `Structured configuration nesting exceeds ${String(MAX_STRUCTURED_DEPTH)}`,
    path,
    location.line,
    location.column,
  );
}

function validateJsonDepth(value: unknown, source: string): void {
  const pending: {
    readonly value: unknown;
    readonly depth: number;
    readonly path: string;
  }[] = [{ value, depth: 0, path: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    if (current.depth > MAX_STRUCTURED_DEPTH) {
      throw depthError(source, current.path);
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value[index],
          depth: current.depth + 1,
          path: `${current.path}/${String(index)}`,
        });
      }
      continue;
    }
    if (typeof current.value === "object" && current.value !== null) {
      const entries: readonly [string, unknown][] = Object.entries(
        current.value,
      );
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry !== undefined) {
          pending.push({
            value: entry[1],
            depth: current.depth + 1,
            path: `${current.path}/${pointerSegment(entry[0])}`,
          });
        }
      }
    }
  }
}

function yamlKey(value: unknown, index: number): string {
  if (isScalar(value) && typeof value.value === "string") {
    return pointerSegment(value.value);
  }
  return String(index);
}

function yamlOffset(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const range: unknown = Reflect.get(value, "range");
  return Array.isArray(range) && typeof range[0] === "number"
    ? range[0]
    : undefined;
}

function validateYamlDepth(
  contents: unknown,
  source: string,
  text: string,
): void {
  const pending: {
    readonly value: unknown;
    readonly depth: number;
    readonly path: string;
  }[] = [{ value: contents, depth: 0, path: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || current.value === null) {
      continue;
    }
    if (current.depth > MAX_STRUCTURED_DEPTH) {
      throw depthError(
        source,
        current.path,
        offsetLocation(text, yamlOffset(current.value)),
      );
    }
    if (isMap(current.value)) {
      for (let index = current.value.items.length - 1; index >= 0; index -= 1) {
        const pair = current.value.items[index];
        if (isPair(pair)) {
          pending.push({
            value: pair.value,
            depth: current.depth + 1,
            path: `${current.path}/${yamlKey(pair.key, index)}`,
          });
        }
      }
    } else if (isSeq(current.value)) {
      for (let index = current.value.items.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value.items[index],
          depth: current.depth + 1,
          path: `${current.path}/${String(index)}`,
        });
      }
    }
  }
}

function parseStructuredText(
  path: string,
  source: string,
  text: string,
): unknown {
  if (path.endsWith(".json")) {
    try {
      const parsed: unknown = JSON.parse(text);
      validateJsonDepth(parsed, source);
      return parsed;
    } catch (error) {
      if (error instanceof StructuredConfigError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Invalid JSON";
      const location = jsonErrorLocation(text, message);
      throw new StructuredConfigError(
        "CONFIG_PARSE_ERROR",
        source,
        "Invalid JSON document",
        "",
        location.line,
        location.column,
      );
    }
  }

  const document = parseDocument(text, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  const error = document.errors[0];
  if (error !== undefined) {
    const start = error.linePos?.[0];
    const fallback = offsetLocation(text, error.pos[0]);
    throw new StructuredConfigError(
      "CONFIG_PARSE_ERROR",
      source,
      "YAML configuration could not be parsed",
      "",
      start?.line ?? fallback.line,
      start?.col ?? fallback.column,
    );
  }
  validateYamlDepth(document.contents, source, text);
  try {
    return document.toJS({ maxAliasCount: 100 }) as unknown;
  } catch {
    throw new StructuredConfigError(
      "CONFIG_PARSE_ERROR",
      source,
      "YAML configuration could not be converted safely",
    );
  }
}

export async function loadStructuredFile(
  path: string,
  options: LoadStructuredFileOptions,
  io: StructuredFileIo = DEFAULT_STRUCTURED_FILE_IO,
): Promise<StructuredSource> {
  let resolvedRoot: string;
  let resolvedPath: string;
  try {
    [resolvedRoot, resolvedPath] = await Promise.all([
      realpath(options.containmentRoot),
      realpath(path),
    ]);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "UNKNOWN";
    throw new StructuredConfigError(
      code === "ENOENT" ? "CONFIG_NOT_FOUND" : "CONFIG_READ_FAILED",
      options.source,
      code === "ENOENT"
        ? "Structured configuration file does not exist"
        : "Structured configuration file could not be resolved",
    );
  }
  if (!isContained(resolvedRoot, resolvedPath)) {
    throw new StructuredConfigError(
      "CONFIG_PATH_ESCAPE",
      options.source,
      "Structured configuration resolves outside its allowed root",
    );
  }

  let handle: FileHandle;
  try {
    handle = await io.open(
      resolvedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new StructuredConfigError(
      "CONFIG_READ_FAILED",
      options.source,
      "Structured configuration file could not be opened",
    );
  }
  let outcome: StructuredReadOutcome;
  try {
    const before = await captureStructuredIdentity(handle);
    await verifyStructuredIdentity(
      path,
      resolvedPath,
      handle,
      before,
      options.source,
    );
    if (before.size > BigInt(MAX_STRUCTURED_FILE_BYTES)) {
      throw new StructuredConfigError(
        "CONFIG_FILE_TOO_LARGE",
        options.source,
        `Structured configuration exceeds ${String(MAX_STRUCTURED_FILE_BYTES)} bytes`,
      );
    }
    const bytes = Number(before.size);
    if (options.budget.bytesRead + bytes > options.budget.maximumBytes) {
      throw new StructuredConfigError(
        "CONFIG_RESOLUTION_TOO_LARGE",
        options.source,
        `Structured configuration resolution exceeds ${String(options.budget.maximumBytes)} bytes`,
      );
    }
    options.budget.bytesRead += bytes;
    const buffer = Buffer.alloc(bytes);
    const bytesRead = await readCompleteFile(handle, buffer);
    await verifyStructuredIdentity(
      path,
      resolvedPath,
      handle,
      before,
      options.source,
    );
    if (bytesRead !== bytes) {
      throw new StructuredConfigError(
        "CONFIG_CHANGED_DURING_READ",
        options.source,
        "Structured configuration changed during policy resolution",
      );
    }
    const text = decodeUtf8(buffer, options.source);
    outcome = {
      ok: true,
      value: {
        source: options.source,
        path: resolvedPath,
        bytes,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        data: parseStructuredText(resolvedPath, options.source, text),
      },
    };
  } catch (error) {
    outcome = {
      ok: false,
      error:
        error instanceof StructuredConfigError
          ? error
          : new StructuredConfigError(
              "CONFIG_READ_FAILED",
              options.source,
              "Structured configuration could not be read consistently",
            ),
    };
  }
  try {
    await handle.close();
  } catch {
    if (outcome.ok) {
      outcome = {
        ok: false,
        error: new StructuredConfigError(
          "CONFIG_READ_FAILED",
          options.source,
          "Structured configuration could not be read consistently",
        ),
      };
    }
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
