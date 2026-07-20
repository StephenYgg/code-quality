import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createExecutableSnapshot,
  MAX_ACTIVE_EXECUTABLE_SNAPSHOTS,
  MAX_EXECUTABLE_SNAPSHOT_BYTES,
  MAX_EXECUTABLE_SNAPSHOT_RESERVED_BYTES,
} from "../../../src/providers/executable-snapshot.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function executable(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", mode: 0o700 });
  await chmod(path, 0o700);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("provider executable snapshots", () => {
  test("copies fixed bytes into a private executable and cleans them up", async () => {
    const directory = await temporaryDirectory("cq-snapshot-source-");
    const source = join(directory, "provider.mjs");
    const replacement = join(directory, "replacement.mjs");
    const trusted = "#!/usr/bin/env node\nprocess.stdout.write('trusted');\n";
    await executable(source, trusted);
    await executable(
      replacement,
      "#!/usr/bin/env node\nprocess.stdout.write('malicious');\n",
    );

    const snapshot = await createExecutableSnapshot({
      kind: "claude_cli",
      executable: source,
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
    });
    await rename(replacement, source);

    expect(await readFile(snapshot.path, "utf8")).toBe(trusted);
    expect((await stat(dirname(snapshot.path))).mode & 0o777).toBe(0o700);
    expect((await stat(snapshot.path)).mode & 0o777).toBe(0o500);
    await snapshot.release();
    await expect(access(snapshot.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await snapshot.release();
  });

  test("rejects unsafe size, abort, and deadline before creating a snapshot", async () => {
    const directory = await temporaryDirectory("cq-snapshot-bounds-");
    const oversized = join(directory, "oversized");
    await writeFile(oversized, "", { mode: 0o700 });
    await truncate(oversized, MAX_EXECUTABLE_SNAPSHOT_BYTES + 1);
    const controller = new AbortController();
    controller.abort();

    await expect(
      createExecutableSnapshot({
        kind: "claude_cli",
        executable: oversized,
        signal: new AbortController().signal,
        deadline: Date.now() + 2_000,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNSAFE" });
    await expect(
      createExecutableSnapshot({
        kind: "claude_cli",
        executable: oversized,
        signal: controller.signal,
        deadline: Date.now() + 2_000,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ABORTED" });
    await expect(
      createExecutableSnapshot({
        kind: "claude_cli",
        executable: oversized,
        signal: new AbortController().signal,
        deadline: Date.now() - 1,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });

  test("rejects unknown scripts with filesystem-relative dependencies", async () => {
    const directory = await temporaryDirectory("cq-snapshot-dependency-");
    const source = join(directory, "provider.mjs");
    await executable(
      source,
      "#!/usr/bin/env node\nimport './provider-support.mjs';\n",
    );

    await expect(
      createExecutableSnapshot({
        kind: "claude_cli",
        executable: source,
        signal: new AbortController().signal,
        deadline: Date.now() + 2_000,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNSAFE" });
  });

  test("resolves a trusted Codex npm wrapper to its platform native binary", async () => {
    const directory = await temporaryDirectory("cq-codex-package-");
    const scope = join(directory, "node_modules", "@openai");
    const wrapper = join(scope, "codex", "bin", "codex.js");
    const platform = platformPackage();
    const native = join(
      scope,
      platform.packageName.slice("@openai/".length),
      "vendor",
      platform.target,
      "codex",
      platform.binary,
    );
    await executable(wrapper, "#!/usr/bin/env node\nimport './support.js';\n");
    await writeFile(
      join(scope, "codex", "package.json"),
      JSON.stringify({ name: "@openai/codex" }),
      "utf8",
    );
    await executable(native, "native-codex-test-binary\n");
    await writeFile(
      join(
        scope,
        platform.packageName.slice("@openai/".length),
        "package.json",
      ),
      JSON.stringify({ name: platform.packageName }),
      "utf8",
    );

    const snapshot = await createExecutableSnapshot({
      kind: "codex_cli",
      executable: wrapper,
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
    });
    try {
      expect(snapshot.sourcePath).toBe(await realpath(native));
      expect(await readFile(snapshot.path, "utf8")).toBe(
        "native-codex-test-binary\n",
      );
    } finally {
      await snapshot.release();
    }
  });

  test("enforces process-wide count capacity without waiting or temp leakage", async () => {
    const directory = await temporaryDirectory("cq-snapshot-capacity-");
    const source = join(directory, "provider.mjs");
    await executable(source, "#!/usr/bin/env node\nprocess.exit(0);\n");
    expect(MAX_ACTIVE_EXECUTABLE_SNAPSHOTS).toBe(2);
    expect(MAX_EXECUTABLE_SNAPSHOT_RESERVED_BYTES).toBe(512 * 1024 * 1024);

    const first = await createExecutableSnapshot({
      kind: "claude_cli",
      executable: source,
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
    });
    const second = await createExecutableSnapshot({
      kind: "claude_cli",
      executable: source,
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
    });
    try {
      await expect(
        createExecutableSnapshot({
          kind: "claude_cli",
          executable: source,
          signal: new AbortController().signal,
          deadline: Date.now() + 2_000,
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_CAPACITY" });
    } finally {
      await Promise.all([first.release(), second.release()]);
    }
  });

  test("retains capacity until failed snapshot cleanup is retried successfully", async () => {
    const directory = await temporaryDirectory("cq-snapshot-release-retry-");
    const source = join(directory, "provider.mjs");
    await executable(source, "#!/usr/bin/env node\nprocess.exit(0);\n");
    let cleanupFails = true;
    const removeDirectory = async (path: string): Promise<void> => {
      if (cleanupFails) throw new Error("controlled snapshot cleanup failure");
      await rm(path, { force: true, recursive: true });
    };
    const create = () =>
      createExecutableSnapshot({
        kind: "claude_cli",
        executable: source,
        signal: new AbortController().signal,
        deadline: Date.now() + 2_000,
        removeDirectory,
      });

    const first = await create();
    const second = await create();
    let replacement: Awaited<ReturnType<typeof create>> | undefined;
    try {
      await expect(first.release()).rejects.toMatchObject({
        code: "PROVIDER_UNSAFE",
      });
      await expect(create()).rejects.toMatchObject({
        code: "PROVIDER_CAPACITY",
      });

      cleanupFails = false;
      await first.release();
      await expect(access(first.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
      replacement = await create();
    } finally {
      cleanupFails = false;
      await Promise.all([
        first.release(),
        second.release(),
        replacement?.release(),
      ]);
    }
  });
});

function platformPackage(): {
  readonly packageName: string;
  readonly target: string;
  readonly binary: string;
} {
  const key = `${process.platform}-${process.arch}`;
  const values: Record<
    string,
    {
      readonly packageName: string;
      readonly target: string;
      readonly binary: string;
    }
  > = {
    "darwin-arm64": {
      packageName: "@openai/codex-darwin-arm64",
      target: "aarch64-apple-darwin",
      binary: "codex",
    },
    "darwin-x64": {
      packageName: "@openai/codex-darwin-x64",
      target: "x86_64-apple-darwin",
      binary: "codex",
    },
    "linux-arm64": {
      packageName: "@openai/codex-linux-arm64",
      target: "aarch64-unknown-linux-musl",
      binary: "codex",
    },
    "linux-x64": {
      packageName: "@openai/codex-linux-x64",
      target: "x86_64-unknown-linux-musl",
      binary: "codex",
    },
    "win32-arm64": {
      packageName: "@openai/codex-win32-arm64",
      target: "aarch64-pc-windows-msvc",
      binary: "codex.exe",
    },
    "win32-x64": {
      packageName: "@openai/codex-win32-x64",
      target: "x86_64-pc-windows-msvc",
      binary: "codex.exe",
    },
  };
  const value = values[key];
  if (value === undefined) throw new Error(`unsupported test platform ${key}`);
  return value;
}
