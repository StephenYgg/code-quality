import {
  freezeCapabilities,
  type HttpProviderConfig,
  type ProviderCapabilities,
  type ProviderReviewRequest,
  type ProviderReviewResponse,
  ProviderError,
} from "./provider.js";
import { HttpReviewProvider } from "./http.js";
import { parseProviderUsage } from "./provider-usage.js";

export class AnthropicCompatibleProvider extends HttpReviewProvider {
  constructor(config: Omit<HttpProviderConfig, "kind">) {
    super({ ...config, kind: "anthropic_compatible" });
  }

  capabilities(): ProviderCapabilities {
    return freezeCapabilities({
      kind: "anthropic_compatible",
      transport: "http",
      structuredOutput: "native_json_schema",
      isolation: "no_tools",
      usage: "reported",
      finishReason: "reported",
      requestId: "reported",
      cancellation: true,
    });
  }

  protected buildRequest(
    request: ProviderReviewRequest,
    credential: string,
  ): {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: unknown;
  } {
    const userText = request.untrustedContext
      .map((part) => `[${part.label}]\n${part.text}`)
      .join("\n\n");
    return {
      url: this.config.endpoint,
      headers: {
        "x-api-key": credential,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: {
        model: request.model,
        system: request.systemInstructions,
        messages: [{ role: "user", content: userText }],
        max_tokens: request.maxOutputTokens,
        output_config: {
          format: {
            type: "json_schema",
            schema: request.outputSchema,
          },
        },
      },
    };
  }

  protected parseResponse(
    response: Response,
    bodyText: string,
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse> {
    void request;
    return Promise.resolve(this.parseResponseSync(response, bodyText));
  }

  private parseResponseSync(
    response: Response,
    bodyText: string,
  ): ProviderReviewResponse {
    let body: unknown;
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Anthropic-compatible response is not JSON",
      );
    }
    if (body === null || typeof body !== "object") {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Anthropic-compatible response envelope is invalid",
      );
    }
    const record = body as {
      readonly content?: readonly {
        readonly type?: string;
        readonly text?: string;
      }[];
      readonly stop_reason?: string;
      readonly usage?: unknown;
    };
    const text = (record.content ?? [])
      .filter(
        (block) => block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text ?? "")
      .join("");
    if (text.length === 0) {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Anthropic-compatible response is missing text content",
      );
    }
    let content: unknown;
    try {
      content = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Anthropic-compatible content is not schema JSON",
      );
    }
    const finish = record.stop_reason ?? "unknown";
    return {
      content,
      usage: parseProviderUsage(record.usage, {
        input: "input_tokens",
        output: "output_tokens",
        total: "total_tokens",
      }),
      finishReason:
        finish === "max_tokens"
          ? "length"
          : finish === "end_turn"
            ? "stop"
            : "unknown",
      rawFinishReason: finish,
      providerRequestId: response.headers.get("request-id"),
      truncated: finish === "max_tokens",
      attemptsUsed: 1,
    };
  }
}
