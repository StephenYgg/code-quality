import { constants } from "node:fs";
import {
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  BoundedFileReadError,
  readBoundedUtf8File,
  type BoundedFileIo,
} from "../../../src/core/bounded-file.js";

const temporaryDirectories: string[] = [];

async function createFile(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cq-bounded-file-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "input.json");
  await writeFile(path, content, "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("readBoundedUtf8File", () => {
  test("reads a stable regular file at the exact byte limit", async () => {
    const path = await createFile("safe");

    await expect(readBoundedUtf8File(path, 4)).resolves.toBe("safe");
  });

  test("rejects a file above the byte limit", async () => {
    const path = await createFile("oversized");

    await expect(readBoundedUtf8File(path, 4)).rejects.toMatchObject({
      code: "FILE_LIMIT_EXCEEDED",
    } satisfies Partial<BoundedFileReadError>);
  });

  test("rejects invalid UTF-8 without returning replacement text", async () => {
    const path = await createFile("safe");
    await writeFile(path, Buffer.from([0xc3, 0x28]));

    await expect(readBoundedUtf8File(path, 4)).rejects.toMatchObject({
      code: "INVALID_UTF8",
    } satisfies Partial<BoundedFileReadError>);
  });

  test("fails closed when the pathname is replaced after its descriptor opens", async () => {
    const path = await createFile("trusted");
    const replacement = join(path, "..", "replacement.json");
    const moved = join(path, "..", "opened.json");
    await writeFile(replacement, "replacement", "utf8");
    const io: BoundedFileIo = {
      realpath,
      stat,
      open: async (resolvedPath, flags) => {
        const handle = await open(resolvedPath, flags);
        await rename(path, moved);
        await rename(replacement, path);
        return handle;
      },
    };

    await expect(readBoundedUtf8File(path, 32, io)).rejects.toMatchObject({
      code: "FILE_CHANGED",
    } satisfies Partial<BoundedFileReadError>);
  });

  test("opens without following a replacement symlink", async () => {
    const path = await createFile("safe");
    let openedFlags = 0;
    const io: BoundedFileIo = {
      realpath,
      stat,
      open: async (resolvedPath, flags) => {
        openedFlags = flags;
        return open(resolvedPath, flags);
      },
    };

    await readBoundedUtf8File(path, 16, io);

    expect(openedFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  });

  test("maps a close failure after a successful read to READ_FAILED", async () => {
    const path = await createFile("safe");
    const io: BoundedFileIo = {
      realpath,
      stat,
      open: async (resolvedPath, flags) =>
        closeFailingHandle(await open(resolvedPath, flags)),
    };

    await expect(readBoundedUtf8File(path, 16, io)).rejects.toMatchObject({
      code: "READ_FAILED",
    } satisfies Partial<BoundedFileReadError>);
  });

  test("does not let a close failure replace the primary bounded-read error", async () => {
    const path = await createFile("oversized");
    const io: BoundedFileIo = {
      realpath,
      stat,
      open: async (resolvedPath, flags) =>
        closeFailingHandle(await open(resolvedPath, flags)),
    };

    await expect(readBoundedUtf8File(path, 4, io)).rejects.toMatchObject({
      code: "FILE_LIMIT_EXCEEDED",
    } satisfies Partial<BoundedFileReadError>);
  });
});

function closeFailingHandle(handle: Awaited<ReturnType<typeof open>>) {
  const close = handle.close.bind(handle);
  Object.defineProperty(handle, "close", {
    configurable: true,
    value: async () => {
      await close();
      throw new Error("controlled close failure");
    },
  });
  return handle;
}
