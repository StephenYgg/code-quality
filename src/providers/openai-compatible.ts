import {
  freezeCapabilities,
  type HttpProviderConfig,
  type ProviderCapabilities,
  type ProviderReviewRequest,
  type ProviderReviewResponse,
  ProviderError,
} from "./provider.js";
import { HttpReviewProvider } from "./http.js";

export class OpenAiCompatibleProvider extends HttpReviewProvider {
  constructor(config: Omit<HttpProviderConfig, "kind">) {
    super({ ...config, kind: "openai_compatible" });
  }

  capabilities(): ProviderCapabilities {
    return freezeCapabilities({
      kind: "openai_compatible",
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
    const userText = [
      request.systemInstructions,
      ...request.untrustedContext.map(
        (part) => `[${part.label}]\n${part.text}`,
      ),
    ].join("\n\n");
    return {
      url: this.config.endpoint,
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: {
        model: request.model,
        messages: [
          { role: "system", content: request.systemInstructions },
          { role: "user", content: userText },
        ],
        n: 1,
        stream: false,
        max_completion_tokens: request.maxOutputTokens,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "cq_review",
            strict: true,
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
        "OpenAI-compatible response is not JSON",
      );
    }
    if (body === null || typeof body !== "object") {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "OpenAI-compatible response envelope is invalid",
      );
    }
    const record = body as {
      readonly choices?: readonly {
        readonly message?: {
          readonly content?: string | null;
          readonly refusal?: string | null;
        };
        readonly finish_reason?: string;
      }[];
      readonly usage?: {
        readonly prompt_tokens?: number;
        readonly completion_tokens?: number;
        readonly total_tokens?: number;
      };
    };
    const choice = record.choices?.[0];
    const contentText = choice?.message?.content;
    if (choice?.message?.refusal) {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "OpenAI-compatible provider refused the request",
      );
    }
    if (typeof contentText !== "string" || contentText.length === 0) {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "OpenAI-compatible response is missing content",
      );
    }
    let content: unknown;
    try {
      content = JSON.parse(contentText) as unknown;
    } catch {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "OpenAI-compatible content is not schema JSON",
      );
    }
    const input = record.usage?.prompt_tokens ?? 0;
    const output = record.usage?.completion_tokens ?? 0;
    const finish = choice?.finish_reason ?? "unknown";
    return {
      content,
      usage: {
        inputTokens: input,
        outputTokens: output,
        totalTokens: record.usage?.total_tokens ?? input + output,
      },
      finishReason:
        finish === "length"
          ? "length"
          : finish === "content_filter"
            ? "content_filter"
            : finish === "stop"
              ? "stop"
              : "unknown",
      rawFinishReason: finish,
      providerRequestId: response.headers.get("x-request-id"),
      truncated: finish === "length",
      attemptsUsed: 1,
    };
  }
}
