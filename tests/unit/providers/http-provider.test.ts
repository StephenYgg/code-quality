import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AnthropicCompatibleProvider } from "../../../src/providers/anthropic-compatible.js";
import { OpenAiCompatibleProvider } from "../../../src/providers/openai-compatible.js";
import type { ProviderReviewRequest } from "../../../src/providers/provider.js";

function baseRequest(
  overrides: Partial<ProviderReviewRequest> = {},
): ProviderReviewRequest {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    stageId: "behavior",
    model: "test-model",
    systemInstructions: "system",
    untrustedContext: [],
    outputSchema: { type: "object" },
    maxOutputTokens: 100,
    timeoutMs: 2_000,
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: 64 * 1024,
    maxDiagnosticBytes: 16 * 1024,
    signal: new AbortController().signal,
    attemptBudget: { maxAttempts: 1, used: 0 },
    ...overrides,
  };
}

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: JSON.stringify({ ok: true }) },
          finish_reason: "stop",
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function provider(options: {
  readonly fetchImpl: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    endpoint: "http://127.0.0.1/v1/chat/completions",
    model: "test-model",
    allowedModels: ["test-model"],
    credentialEnv: "CQ_TEST_TOKEN",
    allowLoopbackHttp: true,
    fetchImpl: options.fetchImpl,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(process.env, "CQ_TEST_TOKEN");
});

describe("HTTP provider hardening", () => {
  test("rechecks a reentrant caller abort before invoking fetch", async () => {
    process.env.CQ_TEST_TOKEN = "reentrant-abort-token";
    const controller = new AbortController();
    const originalAdd = controller.signal.addEventListener.bind(
      controller.signal,
    );
    Object.defineProperty(controller.signal, "addEventListener", {
      configurable: true,
      value: (...args: Parameters<AbortSignal["addEventListener"]>) => {
        originalAdd(...args);
        controller.abort();
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(successResponse()),
    );

    await expect(
      provider({ fetchImpl }).review(
        baseRequest({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ABORTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("does not await a response cancel that never settles", async () => {
    process.env.CQ_TEST_TOKEN = "bounded-cancel-token";
    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(64)));
      },
      cancel() {
        cancelCalled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const startedAt = Date.now();

    await expect(
      provider({
        fetchImpl: () =>
          Promise.resolve(
            new Response(stream, {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
      }).review(baseRequest({ maxResponseBytes: 8 })),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE" });
    expect(cancelCalled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
  }, 1_000);

  test("does not await redirect body cancellation", async () => {
    process.env.CQ_TEST_TOKEN = "bounded-redirect-token";
    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const startedAt = Date.now();

    await expect(
      provider({
        fetchImpl: () =>
          Promise.resolve(
            new Response(stream, {
              status: 302,
              headers: { location: "https://example.invalid/sink" },
            }),
          ),
      }).review(baseRequest()),
    ).rejects.toMatchObject({ code: "PROVIDER_UNSAFE" });
    expect(cancelCalled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
  }, 1_000);

  test("trims and snapshots the credential exactly once", async () => {
    let reads = 0;
    const env = new Proxy<NodeJS.ProcessEnv>(
      { CQ_TEST_TOKEN: "unused" },
      {
        get(target, property, receiver) {
          if (property !== "CQ_TEST_TOKEN") {
            return Reflect.get(target, property, receiver) as
              string | undefined;
          }
          reads += 1;
          return reads === 1
            ? "  snapshot-token-value  "
            : "rotated-token-value";
        },
      },
    );
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer snapshot-token-value",
      });
      return Promise.resolve(successResponse());
    });

    await expect(
      provider({ env, fetchImpl }).review(baseRequest()),
    ).resolves.toBeDefined();
    expect(reads).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("rejects a whitespace-only credential without fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      provider({ env: { CQ_TEST_TOKEN: "   \t " }, fetchImpl }).review(
        baseRequest(),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_CONFIG_INVALID" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("redacts the trimmed credential representation", () => {
    const reviewProvider = provider({
      env: { CQ_TEST_TOKEN: "  trimmed-diagnostic-secret  " },
      fetchImpl: vi.fn<typeof fetch>(),
    });

    const diagnostic = reviewProvider.redactDiagnostic(
      "token=trimmed-diagnostic-secret",
    );
    expect(diagnostic).not.toContain("trimmed-diagnostic-secret");
    expect(diagnostic).toContain("[REDACTED]");
  });

  test("rejects an oversized schema before Ajv compilation", async () => {
    process.env.CQ_TEST_TOKEN = "schema-byte-token";
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      provider({ fetchImpl }).review(
        baseRequest({
          outputSchema: {
            type: "object",
            description: "x".repeat(70 * 1024),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_TOO_LARGE" });
    expect(compile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects excessive schema depth before Ajv compilation", async () => {
    process.env.CQ_TEST_TOKEN = "schema-depth-token";
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const fetchImpl = vi.fn<typeof fetch>();
    let outputSchema: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 80; index += 1) {
      outputSchema = { not: outputSchema };
    }

    await expect(
      provider({ fetchImpl }).review(baseRequest({ outputSchema })),
    ).rejects.toMatchObject({ code: "PROVIDER_CONFIG_INVALID" });
    expect(compile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects excessive schema nodes before Ajv compilation", async () => {
    process.env.CQ_TEST_TOKEN = "schema-node-token";
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const fetchImpl = vi.fn<typeof fetch>();
    const outputSchema = {
      allOf: Array.from({ length: 5_000 }, () => ({ type: "string" })),
    };

    await expect(
      provider({ fetchImpl }).review(baseRequest({ outputSchema })),
    ).rejects.toMatchObject({ code: "PROVIDER_CONFIG_INVALID" });
    expect(compile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("sends OpenAI auth and reports usage without exposing the credential", async () => {
    const env = { CQ_TEST_TOKEN: "openai-contract-token" };
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer openai-contract-token",
      });
      expect(typeof init?.body === "string" ? init.body : "").toContain(
        "test-model",
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: JSON.stringify({ candidates: [] }) },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 4,
              total_tokens: 7,
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "x-request-id": "req-1",
            },
          },
        ),
      );
    });
    const reviewProvider = provider({ env, fetchImpl });

    const result = await reviewProvider.review(baseRequest());
    expect(result.usage?.totalTokens).toBe(7);
    expect(result.providerRequestId).toBe("req-1");
    expect(
      reviewProvider.redactDiagnostic("token=openai-contract-token"),
    ).toContain("[REDACTED]");
  });

  test("parses Anthropic text blocks and reports the request id", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      expect(init?.headers).toMatchObject({
        "x-api-key": "anthropic-contract-token",
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({ candidates: [] }),
              },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 2, output_tokens: 5 },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "request-id": "anth-1",
            },
          },
        ),
      );
    });
    const reviewProvider = new AnthropicCompatibleProvider({
      endpoint: "http://127.0.0.1/v1/messages",
      model: "test-model",
      allowedModels: ["test-model"],
      credentialEnv: "CQ_TEST_TOKEN",
      allowLoopbackHttp: true,
      env: { CQ_TEST_TOKEN: "anthropic-contract-token" },
      fetchImpl,
    });

    const result = await reviewProvider.review(baseRequest());
    expect(result.finishReason).toBe("stop");
    expect(result.providerRequestId).toBe("anth-1");
    expect(result.usage?.totalTokens).toBe(7);
  });

  test("repairs invalid HTTP output within the global attempt budget", async () => {
    let attempts = 0;
    const bodies: string[] = [];
    const reviewProvider = provider({
      env: { CQ_TEST_TOKEN: "repair-contract-token" },
      fetchImpl: (_url, init) => {
        attempts += 1;
        bodies.push(typeof init?.body === "string" ? init.body : "");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      attempts === 1
                        ? "not-json"
                        : JSON.stringify({ candidates: [] }),
                  },
                  finish_reason: "stop",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
    });

    const result = await reviewProvider.review(
      baseRequest({ attemptBudget: { maxAttempts: 2, used: 0 } }),
    );
    expect(result.attemptsUsed).toBe(2);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("previous response failed validation");
  });

  test("repairs HTTP output with invalid usage metadata", async () => {
    let attempts = 0;
    const reviewProvider = provider({
      env: { CQ_TEST_TOKEN: "usage-repair-token" },
      fetchImpl: () => {
        attempts += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: JSON.stringify({ candidates: [] }) },
                  finish_reason: "stop",
                },
              ],
              usage:
                attempts === 1
                  ? {
                      prompt_tokens: "3",
                      completion_tokens: 4,
                      total_tokens: 7,
                    }
                  : {
                      prompt_tokens: 3,
                      completion_tokens: 4,
                      total_tokens: 7,
                    },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
    });

    const result = await reviewProvider.review(
      baseRequest({ attemptBudget: { maxAttempts: 2, used: 0 } }),
    );
    expect(result.attemptsUsed).toBe(2);
    expect(attempts).toBe(2);
  });

  test("rejects insecure non-loopback HTTP endpoints", async () => {
    const reviewProvider = new OpenAiCompatibleProvider({
      endpoint: "http://example.com/v1",
      model: "test-model",
      allowedModels: ["test-model"],
      credentialEnv: "CQ_TEST_TOKEN",
      env: { CQ_TEST_TOKEN: "config-contract-token" },
      fetchImpl: vi.fn<typeof fetch>(),
    });

    await expect(reviewProvider.validateConfiguration()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PROVIDER_ENDPOINT_INSECURE" }),
      ]),
    );
  });
});
