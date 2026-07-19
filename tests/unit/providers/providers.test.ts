import { chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { ClaudeCliProvider } from "../../../src/providers/claude-cli.js";
import { CodexCliProvider } from "../../../src/providers/codex-cli.js";
import { OpenAiCompatibleProvider } from "../../../src/providers/openai-compatible.js";
import { AnthropicCompatibleProvider } from "../../../src/providers/anthropic-compatible.js";
import type { ProviderReviewRequest } from "../../../src/providers/provider.js";

const fakeCli = fileURLToPath(
  new URL("../../fixtures/providers/fake-cli.mjs", import.meta.url),
);

function baseRequest(
  overrides: Partial<ProviderReviewRequest> = {},
): ProviderReviewRequest {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    stageId: "behavior",
    model: "test-model",
    systemInstructions: "system",
    untrustedContext: [
      { role: "untrusted", label: "code", text: "const x = 1;" },
    ],
    outputSchema: { type: "object" },
    maxOutputTokens: 100,
    timeoutMs: 2_000,
    maxRequestBytes: 64 * 1024,
    maxResponseBytes: 64 * 1024,
    maxDiagnosticBytes: 16 * 1024,
    signal: new AbortController().signal,
    attemptBudget: { maxAttempts: 2, used: 0 },
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.CQ_FAKE_PROVIDER_MODE;
  delete process.env.CQ_TEST_TOKEN;
});

describe("providers", () => {
  test("codex and claude process providers parse structured output", async () => {
    await chmod(fakeCli, 0o700);
    const codex = new CodexCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    const claude = new ClaudeCliProvider({
      executable: fakeCli,
      model: "test-model",
      allowedModels: ["test-model"],
    });
    expect(codex.capabilities().kind).toBe("codex_cli");
    expect(claude.capabilities().kind).toBe("claude_cli");
    const codexResult = await codex.review(baseRequest());
    const claudeResult = await claude.review(baseRequest());
    expect(codexResult.content).toMatchObject({ summary: "ok" });
    expect(claudeResult.content).toMatchObject({ summary: "ok" });
  });

  test("openai-compatible provider uses local HTTP and redacts secrets", async () => {
    process.env.CQ_TEST_TOKEN = "super-secret-token-value";
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        expect(request.headers.authorization).toBe(
          "Bearer super-secret-token-value",
        );
        expect(body).toContain("test-model");
        response.writeHead(200, {
          "Content-Type": "application/json",
          "x-request-id": "req-1",
        });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ candidates: [] }),
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 4,
              total_tokens: 7,
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const provider = new OpenAiCompatibleProvider({
      endpoint: `http://127.0.0.1:${String(address.port)}/v1/chat/completions`,
      model: "test-model",
      allowedModels: ["test-model"],
      credentialEnv: "CQ_TEST_TOKEN",
      allowLoopbackHttp: true,
    });
    const result = await provider.review(baseRequest());
    expect(result.usage?.totalTokens).toBe(7);
    expect(
      provider.redactDiagnostic("token=super-secret-token-value"),
    ).toContain("[REDACTED]");
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  test("anthropic-compatible provider parses text blocks", async () => {
    process.env.CQ_TEST_TOKEN = "anthropic-secret-token";
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "request-id": "anth-1",
      });
      response.end(
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
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const provider = new AnthropicCompatibleProvider({
      endpoint: `http://127.0.0.1:${String(address.port)}/v1/messages`,
      model: "test-model",
      allowedModels: ["test-model"],
      credentialEnv: "CQ_TEST_TOKEN",
      allowLoopbackHttp: true,
    });
    const result = await provider.review(baseRequest());
    expect(result.finishReason).toBe("stop");
    expect(result.providerRequestId).toBe("anth-1");
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  test("rejects non-absolute executables and insecure endpoints", async () => {
    const codex = new CodexCliProvider({
      executable: "git",
      model: "test-model",
      allowedModels: ["test-model"],
    });
    expect(await codex.validateConfiguration()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PROVIDER_EXECUTABLE_INVALID" }),
      ]),
    );
    const http = new OpenAiCompatibleProvider({
      endpoint: "http://example.com/v1",
      model: "test-model",
      allowedModels: ["test-model"],
      credentialEnv: "CQ_TEST_TOKEN",
    });
    expect(await http.validateConfiguration()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PROVIDER_ENDPOINT_INSECURE" }),
      ]),
    );
  });
});
