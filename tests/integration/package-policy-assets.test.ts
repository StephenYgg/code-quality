import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

const executeFile = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let temporaryDirectory: string;
let installedPackage: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "cq-package-policy-"));
  await executeFile("corepack", ["pnpm", "build"], { cwd: projectRoot });
  await executeFile(
    "corepack",
    ["pnpm", "pack", "--pack-destination", temporaryDirectory],
    { cwd: projectRoot },
  );
  const archive = (await readdir(temporaryDirectory)).find((name) =>
    name.endsWith(".tgz"),
  );
  if (archive === undefined) {
    throw new Error("pnpm pack did not create an archive");
  }
  await executeFile(
    "tar",
    ["-xzf", join(temporaryDirectory, archive), "-C", temporaryDirectory],
    { cwd: projectRoot },
  );
  installedPackage = join(temporaryDirectory, "package");
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe("installed policy assets", () => {
  test("ships every runtime policy asset and resolves built-ins after unpacking", async () => {
    const requiredAssets = [
      "schemas/rule.schema.json",
      "schemas/profile.schema.json",
      "schemas/waiver.schema.json",
      "schemas/finding.schema.json",
      "schemas/score-model.schema.json",
      "schemas/run.schema.json",
      "profiles/default.yaml",
      "rules/builtin/universal.yaml",
      "src/core/policy.ts",
      "docs/PROGRESS.md",
      "docs/standards/readability.md",
      "docs/standards/concurrency.md",
      "docs/playbooks/review-process.md",
      "skills/code-quality-review/SKILL.md",
    ];
    for (const asset of requiredAssets) {
      await expect(
        import("node:fs/promises").then(({ access }) =>
          access(join(installedPackage, asset)),
        ),
      ).resolves.toBeUndefined();
    }

    const repository = join(temporaryDirectory, "empty-repository");
    await mkdir(repository);
    const moduleUrl = pathToFileURL(
      join(installedPackage, "dist", "core", "policy.js"),
    ).href;
    const module: unknown = await import(`${moduleUrl}?installed=1`);
    const resolver: unknown =
      typeof module === "object" && module !== null
        ? Reflect.get(module, "resolveEffectivePolicy")
        : undefined;
    expect(resolver).toBeTypeOf("function");
    if (typeof resolver !== "function") {
      return;
    }

    const result: unknown = await Reflect.apply(resolver, undefined, [
      { repository },
    ]);
    const policy: unknown =
      typeof result === "object" && result !== null
        ? Reflect.get(result, "policy")
        : undefined;
    const diagnostics: unknown =
      typeof result === "object" && result !== null
        ? Reflect.get(result, "diagnostics")
        : undefined;
    const rules: unknown =
      typeof policy === "object" && policy !== null
        ? Reflect.get(policy, "rules")
        : undefined;
    expect(diagnostics).toEqual([]);
    expect(rules).toHaveLength(15);

    const progress = await executeFile(
      process.execPath,
      [join(installedPackage, "scripts", "check-progress.mjs")],
      { cwd: installedPackage },
    );
    expect(progress.stdout).toContain("percentage=97.4");
  });
});
