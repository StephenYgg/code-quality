import {
  appendFile,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

type ReadIntoBuffer = (
  reader: {
    read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ readonly bytesRead: number }>;
  },
  buffer: Buffer,
) => Promise<number>;

type CaptureInstructionIdentity = (handle: FileHandle) => Promise<unknown>;
type VerifyInstructionIdentity = (
  repository: string,
  path: string,
  handle: FileHandle,
  identity: unknown,
) => Promise<void>;

describe("bounded instruction reader", () => {
  test("continues positioned reads until the buffer is full", async () => {
    const module = await import("../../../src/instructions/bounded-reader.js");
    const candidate: unknown = Reflect.get(module, "readIntoBuffer");

    expect(candidate).toBeTypeOf("function");
    if (typeof candidate !== "function") {
      return;
    }

    const readIntoBuffer = candidate as ReadIntoBuffer;
    const chunks = [Buffer.from("ab"), Buffer.from("c"), Buffer.from("def")];
    const positions: number[] = [];
    const reader = {
      read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ): Promise<{ readonly bytesRead: number }> {
        positions.push(position);
        const chunk = chunks.shift();
        if (chunk === undefined) {
          return Promise.resolve({ bytesRead: 0 });
        }
        const bytesRead = Math.min(length, chunk.length);
        chunk.copy(buffer, offset, 0, bytesRead);
        return Promise.resolve({ bytesRead });
      },
    };
    const buffer = Buffer.alloc(6);

    const bytesRead = await readIntoBuffer(reader, buffer);

    expect(bytesRead).toBe(6);
    expect(buffer.toString("utf8")).toBe("abcdef");
    expect(positions).toEqual([0, 2, 3]);
  });

  test.each(["in-place mutation", "pathname replacement"])(
    "rejects %s after capturing the opened file identity",
    async (change) => {
      const repository = await mkdtemp(join(tmpdir(), "cq-reader-"));
      const path = join(repository, "AGENTS.md");
      await writeFile(path, "# Original\n", "utf8");
      const handle = await open(path, "r");
      try {
        const module =
          await import("../../../src/instructions/bounded-reader.js");
        const captureCandidate: unknown = Reflect.get(
          module,
          "captureInstructionIdentity",
        );
        const verifyCandidate: unknown = Reflect.get(
          module,
          "verifyInstructionIdentity",
        );

        expect(captureCandidate).toBeTypeOf("function");
        expect(verifyCandidate).toBeTypeOf("function");
        if (
          typeof captureCandidate !== "function" ||
          typeof verifyCandidate !== "function"
        ) {
          return;
        }

        const capture = captureCandidate as CaptureInstructionIdentity;
        const verify = verifyCandidate as VerifyInstructionIdentity;
        const identity = await capture(handle);
        if (change === "in-place mutation") {
          await appendFile(path, "changed\n", "utf8");
        } else {
          await rename(path, join(repository, "opened-AGENTS.md"));
          await writeFile(path, "# Replacement\n", "utf8");
        }

        await expect(
          verify(repository, path, handle, identity),
        ).rejects.toThrow("changed during validation");
      } finally {
        await handle.close();
        await rm(repository, { force: true, recursive: true });
      }
    },
  );
});
