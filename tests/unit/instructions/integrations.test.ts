import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  installManagedIntegration,
  planManagedBlockUpdate,
} from "../../../src/instructions/integrations.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("managed integrations", () => {
  test("preserves unrelated text while updating managed blocks", () => {
    const existing = "# Title\n\nkeep me\n";
    const planned = planManagedBlockUpdate(existing);
    expect(planned.action).toBe("update");
    expect(planned.next).toContain("keep me");
    expect(planned.next).toContain("code-quality managed block begin");
  });

  test("installs only after confirm and refuses path escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-integrations-"));
    temporaryDirectories.push(root);
    const plan = await installManagedIntegration({
      root,
      relativePath: "AGENTS.md",
    });
    expect(plan.output).toContain("Re-run with --confirm");
    const applied = await installManagedIntegration({
      root,
      relativePath: "AGENTS.md",
      confirm: true,
    });
    expect(applied.exitCode).toBe(0);
    const body = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(body).toContain("cq validate");
    await expect(
      installManagedIntegration({
        root,
        relativePath: "../escape.md",
        confirm: true,
      }),
    ).rejects.toThrow(/escape|absolute|invalid/i);
  });

  test("does not destroy surrounding content on update", async () => {
    const root = await mkdtemp(join(tmpdir(), "cq-integrations-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "AGENTS.md"),
      "# Local\n\ncustom note\n",
      "utf8",
    );
    await installManagedIntegration({
      root,
      relativePath: "AGENTS.md",
      confirm: true,
    });
    const body = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(body).toContain("custom note");
    expect(body).toContain("Code Quality CLI");
  });
});
