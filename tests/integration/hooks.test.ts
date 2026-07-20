import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  hooksStatus,
  installHooks,
  uninstallHooks,
} from "../../src/hooks/manager.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function createRepo(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "cq-hooks-"));
  temporaryDirectories.push(repository);
  await executeFile("git", ["init", "--quiet"], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return repository;
}

describe("hooks manager", () => {
  test("plans then installs managed hooks", async () => {
    const repository = await createRepo();
    const plan = await installHooks({
      repository,
      mode: "warn",
    });
    expect(plan.output).toContain("--confirm");
    const installed = await installHooks({
      repository,
      mode: "block",
      confirm: true,
    });
    expect(installed.exitCode).toBe(0);
    const body = await readFile(
      join(repository, ".git", "hooks", "pre-commit"),
      "utf8",
    );
    expect(body).toContain("code-quality managed hook");
    expect(body).toContain("CQ_HOOK_MODE=block");
    expect(body).toContain("CQ_HOOK_PRESET=balanced");
    expect(body).toContain("cq hooks run pre-commit");
    const status = await hooksStatus({ repository });
    expect(status.output).toContain("pre-commit: managed");
    expect(status.output).toContain("preset=balanced");
    expect(status.output).toContain("cacheKey components");
  });

  test("refuses unrecognized hooks and can uninstall managed content", async () => {
    const repository = await createRepo();
    await writeFile(
      join(repository, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\necho custom\n",
      "utf8",
    );
    const refused = await installHooks({
      repository,
      mode: "warn",
      confirm: true,
    });
    expect(refused.exitCode).toBe(2);
    expect(refused.output).toContain("unrecognized");

    await installHooks({
      repository: await createRepo(),
      mode: "warn",
      confirm: true,
    });
    const repo2 = temporaryDirectories.at(-1) ?? repository;
    await uninstallHooks({ repository: repo2, confirm: true });
    await expect(
      access(join(repo2, ".git", "hooks", "pre-commit")),
    ).resolves.toBeUndefined();
  });

  test("uses core.hooksPath instead of writing the inactive default directory", async () => {
    const repository = await createRepo();
    await executeFile("git", ["config", "core.hooksPath", ".githooks"], {
      cwd: repository,
    });

    const installed = await installHooks({
      repository,
      mode: "block",
      confirm: true,
    });

    expect(installed.exitCode).toBe(0);
    await expect(
      readFile(join(repository, ".githooks", "pre-commit"), "utf8"),
    ).resolves.toContain("code-quality managed hook");
    await expect(
      access(join(repository, ".git", "hooks", "pre-commit")),
    ).rejects.toBeDefined();
  });

  test("updates and uninstalls only the managed block", async () => {
    const repository = await createRepo();
    await installHooks({ repository, mode: "warn", confirm: true });
    const path = join(repository, ".git", "hooks", "pre-commit");
    const installed = await readFile(path, "utf8");
    await writeFile(path, `${installed}echo custom-after\n`, "utf8");

    const updated = await installHooks({
      repository,
      mode: "block",
      preset: "strict",
      confirm: true,
    });
    expect(updated.exitCode).toBe(0);
    const updatedBody = await readFile(path, "utf8");
    expect(updatedBody).toContain("CQ_HOOK_MODE=block");
    expect(updatedBody).toContain("CQ_HOOK_PRESET=strict");
    expect(updatedBody).toContain("echo custom-after");

    await uninstallHooks({ repository, confirm: true });
    const uninstalledBody = await readFile(path, "utf8");
    expect(uninstalledBody).toContain("echo custom-after");
    expect(uninstalledBody).not.toContain("code-quality managed hook");
  });

  test("serializes concurrent installs so both hook files use one preset", async () => {
    const repository = await createRepo();
    const results = await Promise.all([
      installHooks({
        repository,
        mode: "warn",
        preset: "balanced",
        confirm: true,
      }),
      installHooks({
        repository,
        mode: "block",
        preset: "strict",
        confirm: true,
      }),
    ]);
    expect(results.every((result) => result.exitCode === 0)).toBe(true);

    const bodies = await Promise.all(
      ["pre-commit", "pre-push"].map((name) =>
        readFile(join(repository, ".git", "hooks", name), "utf8"),
      ),
    );
    const presets = bodies.map(
      (body) => /^CQ_HOOK_PRESET=(\S+)/mu.exec(body)?.[1],
    );
    expect(new Set(presets).size).toBe(1);
  });

  test("rolls both hooks back when applying the second staged file fails", async () => {
    const repository = await createRepo();
    await installHooks({ repository, mode: "warn", confirm: true });
    const hooks = ["pre-commit", "pre-push"] as const;
    const original = await Promise.all(
      hooks.map((name) =>
        readFile(join(repository, ".git", "hooks", name), "utf8"),
      ),
    );
    let failed = false;

    const result = await installHooks({
      repository,
      mode: "block",
      preset: "strict",
      confirm: true,
      io: {
        async renameFile(source, destination) {
          if (
            !failed &&
            source.includes(".staged-") &&
            destination.endsWith("pre-push")
          ) {
            failed = true;
            throw new Error("injected apply failure");
          }
          await rename(source, destination);
        },
      },
    });

    expect(result.exitCode).toBe(2);
    const restored = await Promise.all(
      hooks.map((name) =>
        readFile(join(repository, ".git", "hooks", name), "utf8"),
      ),
    );
    expect(restored).toEqual(original);
  });

  test("removes staged files when a later hook is malformed", async () => {
    const repository = await createRepo();
    const hooksDirectory = join(repository, ".git", "hooks");
    await writeFile(
      join(hooksDirectory, "pre-push"),
      "#!/bin/sh\necho custom\n",
      "utf8",
    );

    const result = await installHooks({
      repository,
      mode: "warn",
      confirm: true,
    });

    expect(result.exitCode).toBe(2);
    expect(
      (await readdir(hooksDirectory)).filter((name) =>
        name.includes(".staged-"),
      ),
    ).toEqual([]);
  });

  test("rejects oversized hook files without reading unbounded content", async () => {
    const repository = await createRepo();
    const path = join(repository, ".git", "hooks", "pre-commit");
    await writeFile(path, `#!/bin/sh\n${"x".repeat(256 * 1024)}\n`, "utf8");

    const result = await installHooks({
      repository,
      mode: "warn",
      confirm: true,
    });

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("Hook file exceeds");
  });
});
