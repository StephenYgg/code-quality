import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ciStatus, installCi } from "../../../src/ci/install.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("ci install", () => {
  test("plans without writing, installs with confirm", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-ci-"));
    temporaryDirectories.push(repository);
    const plan = await installCi({
      repository,
      target: "github",
    });
    expect(plan.output).toContain("--confirm");
    await expect(
      access(join(repository, ".github", "workflows", "code-quality.yml")),
    ).rejects.toBeTruthy();

    const installed = await installCi({
      repository,
      target: "github",
      confirm: true,
    });
    expect(installed.exitCode).toBe(0);
    const body = await readFile(
      join(repository, ".github", "workflows", "code-quality.yml"),
      "utf8",
    );
    expect(body).toContain("corepack pnpm check:release");
    expect(body).toContain("Installed by code-quality");

    const status = await ciStatus({ repository });
    expect(status.output).toContain("github: present");
  });

  test("refuses overwrite without force", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-ci-force-"));
    temporaryDirectories.push(repository);
    await installCi({ repository, target: "gitlab", confirm: true });
    const refused = await installCi({
      repository,
      target: "gitlab",
      confirm: true,
    });
    expect(refused.exitCode).toBe(2);
    const forced = await installCi({
      repository,
      target: "gitlab",
      confirm: true,
      force: true,
    });
    expect(forced.exitCode).toBe(0);
  });

  test("installs only immutable workflow dependencies", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-ci-pins-"));
    temporaryDirectories.push(repository);

    await installCi({ repository, target: "github", confirm: true });
    const github = await readFile(
      join(repository, ".github", "workflows", "code-quality.yml"),
      "utf8",
    );
    const actionReferences = [...github.matchAll(/uses:\s+([^\s]+)/gu)].map(
      (match) => match[1],
    );
    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences).toSatisfy((references: string[]) =>
      references.every((reference) => /@[a-f0-9]{40}$/u.test(reference)),
    );
    expect(github).not.toMatch(/@[vV]\d/u);

    await installCi({ repository, target: "gitlab", confirm: true });
    const gitlab = await readFile(
      join(repository, ".gitlab-ci.code-quality.yml"),
      "utf8",
    );
    expect(gitlab).not.toMatch(/^\s*image:/mu);
    expect(gitlab).toContain("code-quality-node22-locked");
  });
});
