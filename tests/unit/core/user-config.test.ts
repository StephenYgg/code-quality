import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  loadUserConfig,
  parseUserConfigDocument,
  selectUserProvider,
  UserConfigError,
} from "../../../src/core/user-config.js";
import { resolveReviewProvider } from "../../../src/providers/resolve.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

const sample = {
  schemaVersion: "1",
  defaultProvider: "codex",
  providers: [
    {
      name: "codex",
      kind: "codex_cli",
      executable: "/usr/local/bin/codex",
      allowedModels: ["gpt-5"],
      defaultModel: "gpt-5",
    },
    {
      name: "openai",
      kind: "openai_compatible",
      endpoint: "https://api.openai.com/v1/chat/completions",
      credentialEnv: "OPENAI_API_KEY",
      allowedModels: ["gpt-4.1"],
      defaultModel: "gpt-4.1",
    },
  ],
};

describe("user config", () => {
  test("parses and selects providers and models", () => {
    const config = parseUserConfigDocument(sample, "/tmp/config.yaml");
    expect(selectUserProvider(config).model).toBe("gpt-5");
    expect(
      selectUserProvider(config, {
        providerName: "openai",
        model: "gpt-4.1",
      }).provider.kind,
    ).toBe("openai_compatible");
  });

  test("rejects relative executables and unknown models", () => {
    expect(() =>
      parseUserConfigDocument(
        {
          schemaVersion: "1",
          providers: [
            {
              name: "codex",
              kind: "codex_cli",
              executable: "codex",
              allowedModels: ["gpt-5"],
              defaultModel: "gpt-5",
            },
          ],
        },
        "/tmp/config.yaml",
      ),
    ).toThrow(UserConfigError);

    const config = parseUserConfigDocument(sample, "/tmp/config.yaml");
    expect(() =>
      selectUserProvider(config, { providerName: "codex", model: "nope" }),
    ).toThrow(/not allowed/);
  });

  test("loads yaml from disk and resolves a process provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cq-user-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.yaml");
    await writeFile(
      path,
      [
        'schemaVersion: "1"',
        "defaultProvider: codex",
        "providers:",
        "  - name: codex",
        "    kind: codex_cli",
        "    executable: /usr/local/bin/codex",
        "    allowedModels: [gpt-5]",
        "    defaultModel: gpt-5",
        "",
      ].join("\n"),
      "utf8",
    );
    const config = await loadUserConfig({ path });
    expect(config.providers).toHaveLength(1);
    const resolved = await resolveReviewProvider({
      configPath: path,
      providerName: "codex",
    });
    expect(resolved.model).toBe("gpt-5");
    expect(resolved.kind).toBe("codex_cli");
    expect(resolved.egressClass).toBe("local");
  });

  test("missing config path fails closed with actionable message", async () => {
    await expect(
      loadUserConfig({ path: join(tmpdir(), "missing-cq-config.yaml") }),
    ).rejects.toMatchObject({ code: "USER_CONFIG_MISSING" });
  });
});
