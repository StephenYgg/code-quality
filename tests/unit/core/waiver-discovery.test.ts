import {
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createStructuredReadBudget,
  StructuredConfigError,
} from "../../../src/core/config.js";
import {
  discoverWaivers,
  type WaiverDiscoveryIo,
} from "../../../src/core/waiver-discovery.js";

const temporaryDirectories: string[] = [];

interface ControlledWaiverDiscoveryIo extends WaiverDiscoveryIo {
  openDirectoryHandle(path: string, flags: number): Promise<FileHandle>;
}

interface RejectingDirectoryHandleControl {
  readonly cleanup: () => Promise<void>;
  readonly closeCalls: () => number;
  readonly open: (path: string, flags: number) => Promise<FileHandle>;
  readonly openResources: () => number;
}

function rejectingDirectoryHandle(): RejectingDirectoryHandleControl {
  let actualHandle: FileHandle | undefined;
  let closeCalls = 0;
  let openResources = 0;
  return {
    open: async (path, flags) => {
      const handle = await open(path, flags);
      actualHandle = handle;
      openResources += 1;
      return {
        fd: handle.fd,
        stat: handle.stat.bind(handle),
        close: () => {
          closeCalls += 1;
          return Promise.reject(
            new Error("raw directory handle close failure"),
          );
        },
      } as unknown as FileHandle;
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

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "cq-waiver-race-"));
  temporaryDirectories.push(repository);
  return repository;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("waiver location race handling", () => {
  test("normalizes a directory handle cleanup failure after enumeration", async () => {
    const repository = await createRepository();
    const target = join(repository, "waivers");
    await mkdir(target);
    const handle = rejectingDirectoryHandle();
    const io = {
      realpath,
      stat: async (path: string) => stat(path, { bigint: true }),
      openDirectoryHandle: handle.open,
      openDescriptorDirectory: async (descriptor) => ({
        directory: await opendir(target),
        stats: await descriptor.handle.stat({ bigint: true }),
      }),
    } satisfies ControlledWaiverDiscoveryIo;

    try {
      const result = await discoverWaivers(
        repository,
        ["waivers"],
        createStructuredReadBudget(),
        new Date("2026-07-19T12:00:00.000Z"),
        io,
      );

      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "CONFIG_READ_FAILED" }),
      );
      expect(result.diagnostics[0]?.message).not.toContain(
        "raw directory handle close failure",
      );
      expect(handle.closeCalls()).toBe(1);
      expect(handle.openResources()).toBe(1);
    } finally {
      await handle.cleanup();
    }
    expect(handle.openResources()).toBe(0);
  });

  test("preserves a structured directory error when cleanup also fails", async () => {
    const repository = await createRepository();
    const target = join(repository, "waivers");
    await mkdir(target);
    const handle = rejectingDirectoryHandle();
    const io = {
      realpath,
      stat: async (path: string) => stat(path, { bigint: true }),
      openDirectoryHandle: handle.open,
      openDescriptorDirectory: () =>
        Promise.reject(
          new StructuredConfigError(
            "WAIVER_DIRECTORY_UNSUPPORTED",
            "waivers",
            "primary descriptor error",
          ),
        ),
    } satisfies ControlledWaiverDiscoveryIo;

    try {
      const result = await discoverWaivers(
        repository,
        ["waivers"],
        createStructuredReadBudget(),
        new Date("2026-07-19T12:00:00.000Z"),
        io,
      );

      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "WAIVER_DIRECTORY_UNSUPPORTED",
          message: "primary descriptor error",
        }),
      );
      expect(handle.closeCalls()).toBe(1);
      expect(handle.openResources()).toBe(1);
    } finally {
      await handle.cleanup();
    }
    expect(handle.openResources()).toBe(0);
  });

  test.runIf(process.platform === "darwin")(
    "fails closed when Darwin cannot enumerate an opened directory descriptor",
    async () => {
      const repository = await createRepository();
      await mkdir(join(repository, "waivers"));

      const result = await discoverWaivers(
        repository,
        ["waivers"],
        createStructuredReadBudget(),
        new Date("2026-07-19T12:00:00.000Z"),
      );

      expect(result.waivers).toEqual([]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "WAIVER_DIRECTORY_UNSUPPORTED" }),
      );
    },
  );

  test("fails closed when a descriptor enumeration capability is unavailable", async () => {
    const repository = await createRepository();
    await mkdir(join(repository, "waivers"));
    const io: WaiverDiscoveryIo = {
      realpath,
      stat: async (path) => stat(path, { bigint: true }),
      openDescriptorDirectory: () => {
        const error = new Error("descriptor filesystem is unavailable");
        Reflect.set(error, "code", "ENOTDIR");
        return Promise.reject(error);
      },
    };

    const result = await discoverWaivers(
      repository,
      ["waivers"],
      createStructuredReadBudget(),
      new Date("2026-07-19T12:00:00.000Z"),
      io,
    );

    expect(result.waivers).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "WAIVER_DIRECTORY_UNSUPPORTED" }),
    );
  });

  test.each(["exact.yaml", "waiver-directory"])(
    "translates deletion after realpath for %s without rejecting",
    async (location) => {
      const repository = await createRepository();
      const target = join(repository, location);
      if (location.endsWith(".yaml")) {
        await writeFile(target, "schemaVersion: invalid\n", "utf8");
      } else {
        await mkdir(target);
      }
      const targetRealPath = await realpath(target);
      const io: WaiverDiscoveryIo = {
        realpath,
        stat: async (path) => {
          if (path === targetRealPath) {
            const error = new Error("removed after realpath");
            Reflect.set(error, "code", "ENOENT");
            throw error;
          }
          return stat(path, { bigint: true });
        },
      };

      const result = await discoverWaivers(
        repository,
        [location],
        createStructuredReadBudget(),
        new Date("2026-07-19T12:00:00.000Z"),
        io,
      );

      expect(result.waivers).toEqual([]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "WAIVER_LOCATION_CHANGED",
          source: location,
        }),
      ]);
    },
  );

  test("detects directory pathname replacement during enumeration", async () => {
    const repository = await createRepository();
    const target = join(repository, "waivers");
    await mkdir(target);
    const io: WaiverDiscoveryIo = {
      realpath,
      stat: async (path) => stat(path, { bigint: true }),
      beforeDirectoryEnumeration: async (requestedPath) => {
        await rename(requestedPath, `${requestedPath}-opened`);
        await mkdir(requestedPath);
      },
    };

    const result = await discoverWaivers(
      repository,
      ["waivers"],
      createStructuredReadBudget(),
      new Date("2026-07-19T12:00:00.000Z"),
      io,
    );

    expect(result.waivers).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "WAIVER_LOCATION_CHANGED" }),
    );
  });

  test("detects replace-open-restore around the directory opener", async () => {
    const repository = await createRepository();
    const target = join(repository, "waivers");
    const original = `${target}-original`;
    const replacement = `${target}-replacement`;
    await mkdir(target);
    await mkdir(replacement);
    await writeFile(
      join(target, "invalid.yaml"),
      "schemaVersion: invalid\n",
      "utf8",
    );
    const io: WaiverDiscoveryIo = {
      realpath,
      stat: async (path) => stat(path, { bigint: true }),
      openDescriptorDirectory: async () => {
        await rename(target, original);
        await rename(replacement, target);
        const openedStats = await stat(target, { bigint: true });
        const directory = await opendir(target);
        expect(directory.path).toBe(target);
        await rename(target, replacement);
        await rename(original, target);
        return { directory, stats: openedStats };
      },
    };

    const result = await discoverWaivers(
      repository,
      ["waivers"],
      createStructuredReadBudget(),
      new Date("2026-07-19T12:00:00.000Z"),
      io,
    );

    expect(result.waivers).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "WAIVER_LOCATION_CHANGED" }),
    );
  });

  test("opens an already verified descriptor during replace-open-restore", async () => {
    const repository = await createRepository();
    const target = join(repository, "waivers");
    const original = `${target}-original`;
    const replacement = `${target}-replacement`;
    await mkdir(target);
    await mkdir(replacement);
    await writeFile(
      join(target, "invalid.yaml"),
      "schemaVersion: invalid\n",
      "utf8",
    );
    let descriptorOpenerCalled = false;
    const io: WaiverDiscoveryIo = {
      realpath,
      stat: async (path) => stat(path, { bigint: true }),
      openDescriptorDirectory: async (descriptor) => {
        descriptorOpenerCalled = true;
        expect(descriptor.descriptorPath).toBeDefined();
        expect(descriptor.descriptorPath).toContain(
          String(descriptor.handle.fd),
        );
        await rename(target, original);
        await rename(replacement, target);
        const openedStats = await descriptor.handle.stat({ bigint: true });
        const directory = await opendir(original);
        await rename(target, replacement);
        await rename(original, target);
        return { directory, stats: openedStats };
      },
    };

    const result = await discoverWaivers(
      repository,
      ["waivers"],
      createStructuredReadBudget(),
      new Date("2026-07-19T12:00:00.000Z"),
      io,
    );

    expect(descriptorOpenerCalled).toBe(true);
    expect(result.waivers).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "WAIVER_LOCATION_CHANGED",
        source: "waivers",
      }),
    );
  });
});
