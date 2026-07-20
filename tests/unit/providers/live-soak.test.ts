import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { UserConfig } from "../../../src/core/user-config.js";
import {
  isLiveSoakEnabled,
  liveSoakForgeToken,
  liveSoakHttpProvider,
  liveSoakProcessProvider,
} from "../../../src/providers/live-soak.js";

const fakeCli = fileURLToPath(
  new URL("../../fixtures/providers/fake-cli.mjs", import.meta.url),
);
const PROCESS_SOAK_REQUEST_TIMEOUT_MS = 4_000;
const PROCESS_SOAK_TEST_TIMEOUT_MS = 8_000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("live soak helpers", () => {
  test("live flag reads env", () => {
    expect(isLiveSoakEnabled({})).toBe(false);
    expect(isLiveSoakEnabled({ CQ_PROVIDER_LIVE_SOAK: "1" })).toBe(true);
    expect(isLiveSoakEnabled({ CQ_PROVIDER_LIVE_SOAK: "true" })).toBe(true);
  });

  test("forge token missing is a clean diagnostic", async () => {
    const result = await liveSoakForgeToken({
      tokenEnv: "CQ_TEST_MISSING_TOKEN",
      forge: "github",
      env: {},
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("FORGE_TOKEN_MISSING");
  });

  test("forge token probe accepts mock github 200", async () => {
    const result = await liveSoakForgeToken({
      tokenEnv: "CQ_FORGE_TOKEN",
      env: { CQ_FORGE_TOKEN: "ghs_testtoken_for_live_soak_probe" },
      forge: "github",
      fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/github/i);
  });

  test.each([
    [200, true],
    [401, false],
    [302, false],
  ])(
    "cancels a never-ending forge response body without blocking for status %i",
    async (status, expectedOk) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream<Uint8Array>({ cancel });
      const probe = liveSoakForgeToken({
        tokenEnv: "CQ_FORGE_TOKEN",
        env: { CQ_FORGE_TOKEN: "bounded-forge-token-value" },
        forge: "github",
        fetchImpl: () => Promise.resolve(new Response(body, { status })),
      });

      const result = await Promise.race([
        probe,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => {
            resolve("timed-out");
          }, 100);
        }),
      ]);

      expect(result).not.toBe("timed-out");
      if (result === "timed-out") return;
      expect(result.ok).toBe(expectedOk);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  test("probes only the explicitly selected GitLab origin", async () => {
    const requests: { readonly url: string; readonly init?: RequestInit }[] =
      [];
    const result = await liveSoakForgeToken({
      tokenEnv: "CQ_GITLAB_TOKEN",
      env: { CQ_GITLAB_TOKEN: "gitlab-only-token-value" },
      forge: "gitlab",
      fetchImpl: (url, init) => {
        requests.push({
          url:
            typeof url === "string"
              ? url
              : url instanceof URL
                ? url.href
                : url.url,
          ...(init === undefined ? {} : { init }),
        });
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://gitlab.com/api/v4/user");
    expect(requests[0]?.init?.redirect).toBe("manual");
    expect(requests[0]?.init?.headers).toMatchObject({
      "PRIVATE-TOKEN": "gitlab-only-token-value",
    });
    expect(JSON.stringify(requests[0]?.init?.headers)).not.toContain(
      "Authorization",
    );
  });

  test("rejects forge redirects without following another origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://example.invalid/credential-sink" },
        }),
      ),
    );
    const result = await liveSoakForgeToken({
      tokenEnv: "CQ_GITHUB_TOKEN",
      env: { CQ_GITHUB_TOKEN: "github-redirect-token-value" },
      forge: "github",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  test("HTTP live soak uses only the injected synthetic transport", async () => {
    const globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("external network is forbidden"));
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ok: true,
                    ping: "cq-live-soak",
                  }),
                },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const provider = {
      name: "http-live",
      kind: "openai_compatible",
      endpoint: "https://provider.invalid/v1/chat/completions",
      credentialEnv: "CQ_LIVE_TOKEN",
      allowedModels: ["test-model"],
      defaultModel: "test-model",
    } as const;
    const config: UserConfig = {
      schemaVersion: "1",
      defaultProvider: provider.name,
      providers: [provider],
      sourcePath: "/tmp/cq-live-soak-config.yaml",
    };

    const result = await liveSoakHttpProvider(config, provider, {
      env: { CQ_LIVE_TOKEN: "live-injected-token" },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  test(
    "process live soak verifies the exact synthetic response",
    async () => {
      const result = await liveSoakProcessProvider(
        {
          name: "local-codex-live",
          kind: "codex_cli",
          executable: fakeCli,
          allowedModels: ["test-model"],
          defaultModel: "test-model",
        },
        PROCESS_SOAK_REQUEST_TIMEOUT_MS,
      );
      expect(result.ok).toBe(true);
      expect(result.diagnostics).toEqual([]);
    },
    PROCESS_SOAK_TEST_TIMEOUT_MS,
  );
});
