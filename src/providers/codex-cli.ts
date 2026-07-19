import {
  freezeCapabilities,
  type ProcessProviderConfig,
  type ProviderCapabilities,
  type ProviderReviewRequest,
  type ProviderReviewResponse,
  ProviderError,
} from "./provider.js";
import { ProcessReviewProvider } from "./process-provider.js";

export class CodexCliProvider extends ProcessReviewProvider {
  constructor(config: Omit<ProcessProviderConfig, "kind">) {
    super({ ...config, kind: "codex_cli" });
  }

  capabilities(): ProviderCapabilities {
    return freezeCapabilities({
      kind: "codex_cli",
      transport: "process",
      structuredOutput: "native_json_schema",
      isolation: "read_only_sandbox",
      usage: "reported",
      finishReason: "derived",
      requestId: "execution_id",
      cancellation: true,
    });
  }

  protected buildArguments(
    request: ProviderReviewRequest,
    workspace: string,
    schemaPath: string,
  ): readonly string[] {
    return [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--json",
      "--output-schema",
      schemaPath,
      "--model",
      request.model,
      "-C",
      workspace,
      "-",
    ];
  }

  protected parseResponse(
    stdout: Buffer,
    request: ProviderReviewRequest,
  ): ProviderReviewResponse {
    const text = stdout.toString("utf8").trim();
    if (text.length === 0) {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Codex provider returned an empty response",
      );
    }
    let parsed: unknown;
    try {
      // Accept either a pure JSON object or the last JSONL agent message.
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const candidate = lines.at(-1) ?? text;
      parsed = JSON.parse(candidate) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "content" in parsed
      ) {
        const record = parsed as { readonly content?: unknown };
        if (record.content !== undefined) {
          parsed = record.content;
        }
      }
    } catch {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Codex provider returned invalid JSON",
      );
    }
    return {
      content: parsed,
      usage: null,
      finishReason: "stop",
      rawFinishReason: null,
      providerRequestId: request.runId,
      truncated: false,
      attemptsUsed: 1,
    };
  }
}
