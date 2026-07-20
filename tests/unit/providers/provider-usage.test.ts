import { describe, expect, test } from "vitest";

import { AnthropicCompatibleProvider } from "../../../src/providers/anthropic-compatible.js";
import { ClaudeCliProvider } from "../../../src/providers/claude-cli.js";
import { CodexCliProvider } from "../../../src/providers/codex-cli.js";
import { OpenAiCompatibleProvider } from "../../../src/providers/openai-compatible.js";
import type {
  ProviderReviewRequest,
  ProviderReviewResponse,
} from "../../../src/providers/provider.js";
import type { ProcessProviderOutput } from "../../../src/providers/process-provider.js";

const MISSING_USAGE = Symbol("missing usage");
type UsageInput = unknown;

const request: ProviderReviewRequest = {
  runId: "00000000-0000-4000-8000-000000000001",
  stageId: "usage-validation",
  model: "test-model",
  systemInstructions: "system",
  untrustedContext: [],
  outputSchema: { type: "object" },
  maxOutputTokens: 100,
  timeoutMs: 2_000,
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 64 * 1024,
  maxDiagnosticBytes: 16 * 1024,
  signal: new AbortController().signal,
  attemptBudget: { maxAttempts: 1, used: 0 },
};

interface UsageHarness {
  parseUsage(usage: UsageInput): Promise<ProviderReviewResponse>;
}

function withUsage(base: Record<string, unknown>, usage: UsageInput): unknown {
  return usage === MISSING_USAGE ? base : { ...base, usage };
}

class ClaudeUsageHarness extends ClaudeCliProvider implements UsageHarness {
  constructor() {
    super({
      executable: "/unused/claude",
      model: "test-model",
      allowedModels: ["test-model"],
    });
  }

  parseUsage(usage: UsageInput): Promise<ProviderReviewResponse> {
    const envelope = withUsage(
      { structured_output: { ok: true }, is_error: false },
      usage,
    );
    return Promise.resolve().then(() =>
      this.parseResponse(
        {
          stdout: Buffer.from(JSON.stringify(envelope)),
          stderr: Buffer.alloc(0),
          lastMessage: Buffer.alloc(0),
        },
        request,
      ),
    );
  }
}

class OpenAiUsageHarness
  extends OpenAiCompatibleProvider
  implements UsageHarness
{
  constructor() {
    super({
      endpoint: "https://provider.invalid/v1/chat/completions",
      model: "test-model",
      allowedModels: ["test-model"],
      credentialEnv: "UNUSED_TOKEN",
    });
  }

  parseUsage(usage: UsageInput): Promise<ProviderReviewResponse> {
    const envelope = withUsage(
      {
        choices: [
          {
            message: { content: JSON.stringify({ ok: true }) },
            finish_reason: "stop",
          },
        ],
      },
      usage,
    );
    return Promise.resolve().then(() =>
      this.parseResponse(
        new Response(null, { headers: { "x-request-id": "usage-test" } }),
        JSON.stringify(envelope),
        request,
      ),
    );
  }
}

class AnthropicUsageHarness
  extends AnthropicCompatibleProvider
  implements UsageHarness
{
  constructor() {
    super({
      endpoint: "https://provider.invalid/v1/messages",
      model: "test-model",
      allowedModels: ["test-model"],
      credentialEnv: "UNUSED_TOKEN",
    });
  }

  parseUsage(usage: UsageInput): Promise<ProviderReviewResponse> {
    const envelope = withUsage(
      {
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        stop_reason: "end_turn",
      },
      usage,
    );
    return Promise.resolve().then(() =>
      this.parseResponse(
        new Response(null, { headers: { "request-id": "usage-test" } }),
        JSON.stringify(envelope),
        request,
      ),
    );
  }
}

class CodexUsageHarness extends CodexCliProvider implements UsageHarness {
  constructor() {
    super({
      executable: "/unused/codex",
      model: "test-model",
      allowedModels: ["test-model"],
    });
  }

  parseUsage(usage: UsageInput): Promise<ProviderReviewResponse> {
    const event = withUsage({ type: "turn.completed" }, usage);
    const output: ProcessProviderOutput = {
      stdout: Buffer.from(`${JSON.stringify(event)}\n`),
      stderr: Buffer.alloc(0),
      lastMessage: Buffer.from(JSON.stringify({ ok: true })),
    };
    return Promise.resolve().then(() => this.parseResponse(output, request));
  }
}

const adapters = [
  {
    name: "Claude CLI",
    harness: new ClaudeUsageHarness(),
    valid: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    string: { input_tokens: "2", output_tokens: 3, total_tokens: 5 },
    negative: { input_tokens: -1, output_tokens: 3, total_tokens: 2 },
    unsafe: {
      input_tokens: Number.MAX_SAFE_INTEGER + 1,
      output_tokens: 0,
      total_tokens: Number.MAX_SAFE_INTEGER + 1,
    },
    mismatch: { input_tokens: 2, output_tokens: 3, total_tokens: 6 },
  },
  {
    name: "OpenAI-compatible",
    harness: new OpenAiUsageHarness(),
    valid: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    string: { prompt_tokens: "2", completion_tokens: 3, total_tokens: 5 },
    negative: { prompt_tokens: -1, completion_tokens: 3, total_tokens: 2 },
    unsafe: {
      prompt_tokens: Number.MAX_SAFE_INTEGER + 1,
      completion_tokens: 0,
      total_tokens: Number.MAX_SAFE_INTEGER + 1,
    },
    mismatch: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 6 },
  },
  {
    name: "Anthropic-compatible",
    harness: new AnthropicUsageHarness(),
    valid: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    string: { input_tokens: "2", output_tokens: 3, total_tokens: 5 },
    negative: { input_tokens: -1, output_tokens: 3, total_tokens: 2 },
    unsafe: {
      input_tokens: Number.MAX_SAFE_INTEGER + 1,
      output_tokens: 0,
      total_tokens: Number.MAX_SAFE_INTEGER + 1,
    },
    mismatch: { input_tokens: 2, output_tokens: 3, total_tokens: 6 },
  },
] as const;

describe("provider usage validation", () => {
  test.each(adapters)(
    "$name returns null when usage is absent",
    async (entry) => {
      await expect(
        entry.harness.parseUsage(MISSING_USAGE),
      ).resolves.toMatchObject({ usage: null });
    },
  );

  test.each(
    adapters.flatMap((entry) =>
      (["string", "negative", "unsafe", "mismatch"] as const).map((kind) => ({
        name: entry.name,
        harness: entry.harness,
        kind,
        usage: entry[kind],
      })),
    ),
  )("$name rejects $kind usage", async ({ harness, usage }) => {
    await expect(harness.parseUsage(usage)).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
    });
  });

  test.each(adapters)("$name accepts consistent usage", async (entry) => {
    await expect(entry.harness.parseUsage(entry.valid)).resolves.toMatchObject({
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
  });

  test("Codex rejects invalid usage instead of treating it as absent", async () => {
    await expect(
      new CodexUsageHarness().parseUsage({
        input_tokens: "2",
        output_tokens: 3,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });
});
