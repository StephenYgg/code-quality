import { constants, type BigIntStats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { agentDiagnostic } from "../core/agent-diagnostic.js";
import type { ValidationDiagnostic } from "../core/validation.js";
import type { InstructionFile } from "./discovery.js";
import {
  MarkdownLimitError,
  parseInstructionMarkdown,
  type ParsedInstructionMarkdown,
} from "./markdown.js";

export interface ReadInstruction {
  readonly file: InstructionFile;
  readonly parsed: ParsedInstructionMarkdown;
  readonly realPath: string;
}

export interface ReadBudget {
  totalBytes: number;
}

export interface ReadResult {
  readonly instruction?: ReadInstruction;
  readonly diagnostic?: ValidationDiagnostic;
}

export interface PositionedReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
}

export interface InstructionIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
}

function identityFromStat(stats: BigIntStats): InstructionIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    ctimeNs: stats.ctimeNs,
    mtimeNs: stats.mtimeNs,
  };
}

function sameInstructionIdentity(
  left: InstructionIdentity,
  right: InstructionIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

export async function captureInstructionIdentity(
  handle: FileHandle,
): Promise<InstructionIdentity> {
  const current = await handle.stat({ bigint: true });
  if (!current.isFile()) {
    throw new Error("Instruction target is not a regular file");
  }
  return identityFromStat(current);
}

export async function verifyInstructionIdentity(
  repository: string,
  path: string,
  handle: FileHandle,
  expected: InstructionIdentity,
): Promise<void> {
  try {
    const descriptorIdentity = await captureInstructionIdentity(handle);
    const currentRealPath = await realpath(path);
    if (!isInsideRepository(repository, currentRealPath)) {
      throw new Error("outside repository");
    }
    const pathnameStat = await stat(currentRealPath, { bigint: true });
    if (
      !pathnameStat.isFile() ||
      !sameInstructionIdentity(descriptorIdentity, expected) ||
      !sameInstructionIdentity(identityFromStat(pathnameStat), expected)
    ) {
      throw new Error("identity mismatch");
    }
  } catch {
    throw new Error("Instruction target changed during validation");
  }
}

export async function readIntoBuffer(
  reader: PositionedReader,
  buffer: Buffer,
): Promise<number> {
  let totalBytesRead = 0;
  while (totalBytesRead < buffer.length) {
    const { bytesRead } = await reader.read(
      buffer,
      totalBytesRead,
      buffer.length - totalBytesRead,
      totalBytesRead,
    );
    if (bytesRead === 0) {
      break;
    }
    if (bytesRead < 0 || bytesRead > buffer.length - totalBytesRead) {
      throw new RangeError("File reader returned an invalid byte count");
    }
    totalBytesRead += bytesRead;
  }
  return totalBytesRead;
}

export function isInsideRepository(
  repository: string,
  target: string,
): boolean {
  const relativePath = relative(repository, target);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))
  );
}

export async function resolveInstructionRealPath(
  repository: string,
  file: InstructionFile,
): Promise<ReadResult | string> {
  let target: string;
  try {
    target = await realpath(file.absolutePath);
  } catch {
    return {
      diagnostic: agentDiagnostic(
        file.symbolicLink ? "BROKEN_SYMLINK" : "READ_FAILED",
        "incomplete",
        file.relativePath,
        file.symbolicLink
          ? "Instruction symlink could not be resolved"
          : "Instruction file could not be resolved",
      ),
    };
  }
  if (!isInsideRepository(repository, target)) {
    return {
      diagnostic: agentDiagnostic(
        file.symbolicLink ? "SYMLINK_TARGET_MISMATCH" : "READ_FAILED",
        file.symbolicLink ? "policy" : "incomplete",
        file.relativePath,
        "Instruction file resolves outside the repository",
      ),
    };
  }
  return target;
}

export async function readInstruction(
  repository: string,
  file: InstructionFile,
  maxFileBytes: number,
  maxTotalBytes: number,
  budget: ReadBudget,
): Promise<ReadResult> {
  const resolved = await resolveInstructionRealPath(repository, file);
  if (typeof resolved !== "string") {
    return resolved;
  }

  const remainingTotal = maxTotalBytes - budget.totalBytes;
  if (remainingTotal < 1) {
    return {
      diagnostic: agentDiagnostic(
        "TOTAL_LIMIT_EXCEEDED",
        "incomplete",
        file.relativePath,
        `Total instruction byte limit of ${String(maxTotalBytes)} was exceeded`,
      ),
    };
  }

  const allowedBytes = Math.min(maxFileBytes, remainingTotal);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const openedIdentity = await captureInstructionIdentity(handle);
    await verifyInstructionIdentity(
      repository,
      resolved,
      handle,
      openedIdentity,
    );

    const buffer = Buffer.allocUnsafe(allowedBytes + 1);
    const bytesRead = await readIntoBuffer(handle, buffer);
    budget.totalBytes += bytesRead;
    await verifyInstructionIdentity(
      repository,
      resolved,
      handle,
      openedIdentity,
    );
    if (bytesRead > maxFileBytes) {
      return {
        diagnostic: agentDiagnostic(
          "FILE_LIMIT_EXCEEDED",
          "incomplete",
          file.relativePath,
          `Instruction file byte limit of ${String(maxFileBytes)} was exceeded`,
        ),
      };
    }
    if (bytesRead > remainingTotal) {
      return {
        diagnostic: agentDiagnostic(
          "TOTAL_LIMIT_EXCEEDED",
          "incomplete",
          file.relativePath,
          `Total instruction byte limit of ${String(maxTotalBytes)} was exceeded`,
        ),
      };
    }

    const source = buffer.subarray(0, bytesRead).toString("utf8");
    return {
      instruction: {
        file,
        parsed: parseInstructionMarkdown(source),
        realPath: resolved,
      },
    };
  } catch (error) {
    if (error instanceof MarkdownLimitError) {
      return {
        diagnostic: agentDiagnostic(
          "MARKDOWN_LIMIT_EXCEEDED",
          "incomplete",
          file.relativePath,
          error.message,
        ),
      };
    }
    return {
      diagnostic: agentDiagnostic(
        "READ_FAILED",
        "incomplete",
        file.relativePath,
        "Instruction file could not be read",
      ),
    };
  } finally {
    await handle?.close();
  }
}
