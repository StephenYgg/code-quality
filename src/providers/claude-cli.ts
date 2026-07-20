import {
  freezeCapabilities,
  type ProcessProviderConfig,
  type ProviderCapabilities,
  type ProviderReviewRequest,
  type ProviderReviewResponse,
  ProviderError,
} from "./provider.js";
import {
  ProcessReviewProvider,
  type ProcessProviderOutput,
} from "./process-provider.js";
import { CLAUDE_REQUIRED_FLAGS } from "./probe.js";
import { parseProviderUsage } from "./provider-usage.js";

interface ClaudeResponseEnvelope {
  readonly result?: unknown;
  readonly content?: unknown;
  readonly structured_output?: unknown;
  readonly is_error?: boolean;
  readonly usage?: unknown;
  readonly stop_reason?: string;
  readonly session_id?: string;
}

function structuredContent(record: ClaudeResponseEnvelope): unknown {
  if (record.structured_output !== undefined) return record.structured_output;
  if (record.result !== undefined) return record.result;
  if (record.content !== undefined) return record.content;
  throw new ProviderError(
    "PROVIDER_RESPONSE_INVALID",
    "Claude provider response is missing structured content",
  );
}

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

  protected requiredProbeFlags(): readonly string[] {
    return CLAUDE_REQUIRED_FLAGS;
  }

  protected captureSessionEnvironment(): NodeJS.ProcessEnv {
    const environment = super.captureSessionEnvironment();
    if (process.env.HOME !== undefined) environment.HOME = process.env.HOME;
    if (process.env.ANTHROPIC_API_KEY !== undefined) {
      environment.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined) {
      environment.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
      environment.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    }
    return environment;
  }

  protected credentialSecrets(): readonly string[] {
    return [
      process.env.ANTHROPIC_API_KEY,
      process.env.CLAUDE_CODE_OAUTH_TOKEN,
    ].filter((value): value is string => value !== undefined);
  }

  protected buildArguments(
    request: ProviderReviewRequest,
    _workspace: string,
    _schemaPath: string,
    schemaJson: string,
  ): readonly string[] {
    return [
      "--print",
      "--safe-mode",
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "json",
      "--json-schema",
      schemaJson,
      "--model",
      request.model,
      "--no-session-persistence",
    ];
  }

  protected parseResponse(
    output: ProcessProviderOutput,
    request: ProviderReviewRequest,
  ): ProviderReviewResponse {
    let envelope: unknown;
    try {
      envelope = JSON.parse(output.stdout.toString("utf8")) as unknown;
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
    const record = envelope as ClaudeResponseEnvelope;
    if (record.is_error === true) {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Claude provider reported an error response",
      );
    }
    const content = structuredContent(record);
    const truncated = record.stop_reason === "max_tokens";
    let rawFinishReason: string | null = null;
    if (record.stop_reason !== undefined) rawFinishReason = record.stop_reason;
    let providerRequestId = request.runId;
    if (record.session_id !== undefined) providerRequestId = record.session_id;
    return {
      content,
      usage: parseProviderUsage(record.usage, {
        input: "input_tokens",
        output: "output_tokens",
        total: "total_tokens",
      }),
      finishReason: truncated ? "length" : "stop",
      rawFinishReason,
      providerRequestId,
      truncated,
      attemptsUsed: 1,
    };
  }
}
