import { constants, type BigIntStats, type Dir } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  readStableDirectoryEntries,
  type WaiverDirectorySnapshotIo,
} from "../../../src/core/waiver-directory-snapshot.js";

const temporaryDirectories: string[] = [];

interface ControlledDescriptorIo extends WaiverDirectorySnapshotIo {
  openDescriptor(path: string): Promise<Dir>;
  statDescriptor(path: string): Promise<BigIntStats>;
}

async function createDirectoryHandle(): Promise<{
  readonly handle: FileHandle;
  readonly requestedPath: string;
  readonly resolvedPath: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), "cq-waiver-snapshot-"));
  temporaryDirectories.push(repository);
  const requestedPath = join(repository, "waivers");
  await mkdir(requestedPath);
  const resolvedPath = await realpath(requestedPath);
  const handle = await open(
    resolvedPath,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  return { handle, requestedPath, resolvedPath };
}

function controlledDirectory(onClose: () => Promise<void>): Dir {
  return { close: onClose } as unknown as Dir;
}

async function readWithIo(
  handle: FileHandle,
  requestedPath: string,
  resolvedPath: string,
  io: WaiverDirectorySnapshotIo,
): Promise<readonly unknown[]> {
  return readStableDirectoryEntries({
    requestedPath,
    resolvedPath,
    source: "waivers",
    handle,
    io,
    inspectEntry: () => undefined,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("waiver directory descriptor cleanup", () => {
  test("preserves an identity error when an injected directory cannot close", async () => {
    const { handle, requestedPath, resolvedPath } =
      await createDirectoryHandle();
    const replacementPath = join(requestedPath, "..", "replacement");
    await mkdir(replacementPath);
    const replacementStats = await stat(replacementPath, { bigint: true });
    let closeCalls = 0;
    const openResources = 1;
    const io: WaiverDirectorySnapshotIo = {
      stat: async (path: string) => stat(path, { bigint: true }),
      openDescriptorDirectory: () =>
        Promise.resolve({
          stats: replacementStats,
          directory: controlledDirectory(() => {
            closeCalls += 1;
            return Promise.reject(new Error("raw injected close failure"));
          }),
        }),
    };

    try {
      const rejection = readWithIo(handle, requestedPath, resolvedPath, io);
      await expect(rejection).rejects.toMatchObject({
        code: "WAIVER_LOCATION_CHANGED",
      });
      await expect(rejection).rejects.not.toThrow("raw injected close failure");
      expect(closeCalls).toBe(1);
      expect(openResources).toBe(1);
    } finally {
      await handle.close();
    }
  });

  test("does not run a fallible descriptor stat after opening", async () => {
    const { handle, requestedPath, resolvedPath } =
      await createDirectoryHandle();
    const descriptorStats = await stat(resolvedPath, { bigint: true });
    let descriptorStatCalls = 0;
    let descriptorOpen = false;
    let postOpenStatCalls = 0;
    let openResources = 0;
    const io = {
      stat: async (path: string) => stat(path, { bigint: true }),
      statDescriptor: () => {
        if (descriptorOpen) {
          postOpenStatCalls += 1;
          return Promise.reject(new Error("post-open descriptor stat"));
        }
        descriptorStatCalls += 1;
        return Promise.resolve(descriptorStats);
      },
      openDescriptor: async () => {
        const directory = await opendir(resolvedPath);
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          descriptorOpen = false;
          openResources -= 1;
        };
        descriptorOpen = true;
        openResources += 1;
        return {
          close: async () => {
            try {
              await directory.close();
            } finally {
              release();
            }
          },
          async *[Symbol.asyncIterator]() {
            try {
              for await (const entry of directory) yield entry;
            } finally {
              release();
            }
          },
        } as unknown as Dir;
      },
    } satisfies ControlledDescriptorIo;

    try {
      await expect(
        readWithIo(handle, requestedPath, resolvedPath, io),
      ).resolves.toEqual([]);
      expect(descriptorStatCalls).toBe(2);
      expect(postOpenStatCalls).toBe(0);
      expect(openResources).toBe(0);
    } finally {
      await handle.close();
    }
  });
});
