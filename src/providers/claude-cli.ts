import {
  freezeCapabilities,
  type ProcessProviderConfig,
  type ProviderCapabilities,
  type ProviderReviewRequest,
  type ProviderReviewResponse,
  ProviderError,
} from "./provider.js";
import { ProcessReviewProvider } from "./process-provider.js";

export class ClaudeCliProvider extends ProcessReviewProvider {
  constructor(config: Omit<ProcessProviderConfig, "kind">) {
    super({ ...config, kind: "claude_cli" });
  }

  capabilities(): ProviderCapabilities {
    return freezeCapabilities({
      kind: "claude_cli",
      transport: "process",
      structuredOutput: "native_json_schema",
      isolation: "no_tools",
      usage: "reported",
      finishReason: "reported",
      requestId: "execution_id",
      cancellation: true,
    });
  }

  protected buildArguments(
    request: ProviderReviewRequest,
    _workspace: string,
    schemaPath: string,
  ): readonly string[] {
    return [
      "--print",
      "--bare",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "json",
      "--json-schema",
      schemaPath,
      "--model",
      request.model,
      "--no-session-persistence",
    ];
  }

  protected parseResponse(
    stdout: Buffer,
    request: ProviderReviewRequest,
  ): ProviderReviewResponse {
    let envelope: unknown;
    try {
      envelope = JSON.parse(stdout.toString("utf8")) as unknown;
    } catch {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Claude provider returned invalid JSON",
      );
    }
    if (envelope === null || typeof envelope !== "object") {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Claude provider response envelope is invalid",
      );
    }
    const record = envelope as {
      readonly result?: unknown;
      readonly content?: unknown;
      readonly usage?: {
        readonly input_tokens?: number;
        readonly output_tokens?: number;
      };
      readonly stop_reason?: string;
      readonly session_id?: string;
    };
    const content = record.result ?? record.content;
    if (content === undefined) {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Claude provider response is missing structured content",
      );
    }
    const input = record.usage?.input_tokens ?? 0;
    const output = record.usage?.output_tokens ?? 0;
    return {
      content,
      usage: {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
      },
      finishReason: record.stop_reason === "max_tokens" ? "length" : "stop",
      rawFinishReason: record.stop_reason ?? null,
      providerRequestId: record.session_id ?? request.runId,
      truncated: record.stop_reason === "max_tokens",
      attemptsUsed: 1,
    };
  }
}
