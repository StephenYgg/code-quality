import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createStructuredReadBudget,
  loadStructuredFile,
  StructuredConfigError,
  type LoadStructuredFileOptions,
  type StructuredFileIo,
} from "../../../src/core/config.js";

const temporaryDirectories: string[] = [];

async function createConfig(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cq-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, content, "utf8");
  return path;
}

function optionsFor(path: string): LoadStructuredFileOptions {
  return {
    containmentRoot: join(path, ".."),
    source: "config.json",
    budget: createStructuredReadBudget(),
  };
}

interface RejectingHandleControl {
  readonly io: StructuredFileIo;
  readonly cleanup: () => Promise<void>;
  readonly closeCalls: () => number;
  readonly openResources: () => number;
}

function rejectingHandle(readError?: Error): RejectingHandleControl {
  let actualHandle: Awaited<ReturnType<typeof open>> | undefined;
  let closeCalls = 0;
  let openResources = 0;
  return {
    io: {
      open: async (path, flags) => {
        const handle = await open(path, flags);
        actualHandle = handle;
        openResources += 1;
        return {
          stat: handle.stat.bind(handle),
          read:
            readError === undefined
              ? handle.read.bind(handle)
              : () => Promise.reject(readError),
          close: () => {
            closeCalls += 1;
            return Promise.reject(new Error("close failed"));
          },
        } as unknown as Awaited<ReturnType<typeof open>>;
      },
    },
    cleanup: async () => {
      if (actualHandle !== undefined) {
        await actualHandle.close();
        actualHandle = undefined;
        openResources -= 1;
      }
    },
    closeCalls: () => closeCalls,
    openResources: () => openResources,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("loadStructuredFile cleanup failures", () => {
  test("normalizes a close failure after a successful read", async () => {
    const path = await createConfig('{"valid":true}\n');
    const handle = rejectingHandle();

    const result = loadStructuredFile(path, optionsFor(path), handle.io);

    try {
      await expect(result).rejects.toBeInstanceOf(StructuredConfigError);
      await expect(result).rejects.toMatchObject({
        code: "CONFIG_READ_FAILED",
        source: "config.json",
      } satisfies Partial<StructuredConfigError>);
      expect(handle.closeCalls()).toBe(1);
      expect(handle.openResources()).toBe(1);
    } finally {
      await handle.cleanup();
    }
    expect(handle.openResources()).toBe(0);
  });

  test("preserves an earlier structured error when close also fails", async () => {
    const path = await createConfig('{"valid":true}\n');
    const readError = new StructuredConfigError(
      "CONFIG_CHANGED_DURING_READ",
      "config.json",
      "changed",
    );
    const handle = rejectingHandle(readError);

    try {
      await expect(
        loadStructuredFile(path, optionsFor(path), handle.io),
      ).rejects.toBe(readError);
      expect(handle.closeCalls()).toBe(1);
      expect(handle.openResources()).toBe(1);
    } finally {
      await handle.cleanup();
    }
    expect(handle.openResources()).toBe(0);
  });

  test("preserves a normalized raw read failure when close also fails", async () => {
    const path = await createConfig('{"valid":true}\n');
    const handle = rejectingHandle(new Error("read failed"));

    const result = loadStructuredFile(path, optionsFor(path), handle.io);

    try {
      await expect(result).rejects.toBeInstanceOf(StructuredConfigError);
      await expect(result).rejects.toMatchObject({
        code: "CONFIG_READ_FAILED",
        source: "config.json",
      } satisfies Partial<StructuredConfigError>);
      expect(handle.closeCalls()).toBe(1);
      expect(handle.openResources()).toBe(1);
    } finally {
      await handle.cleanup();
    }
    expect(handle.openResources()).toBe(0);
  });
});
