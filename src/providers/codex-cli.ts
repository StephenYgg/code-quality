import { join } from "node:path";

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
import { CODEX_REQUIRED_FLAGS } from "./probe.js";
import { parseProviderUsage } from "./provider-usage.js";

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

  protected requiredProbeFlags(): readonly string[] {
    return CODEX_REQUIRED_FLAGS;
  }

  protected captureSessionEnvironment(): NodeJS.ProcessEnv {
    const environment = super.captureSessionEnvironment();
    const codexHome =
      process.env.CODEX_HOME ??
      (process.env.HOME === undefined
        ? undefined
        : join(process.env.HOME, ".codex"));
    if (codexHome !== undefined) environment.CODEX_HOME = codexHome;
    if (process.env.OPENAI_API_KEY !== undefined) {
      environment.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    }
    if (process.env.CODEX_API_KEY !== undefined) {
      environment.CODEX_API_KEY = process.env.CODEX_API_KEY;
    }
    return environment;
  }

  protected capturesLastMessageOutput(): boolean {
    return true;
  }

  protected credentialSecrets(): readonly string[] {
    return [process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY].filter(
      (value): value is string => value !== undefined,
    );
  }

  protected buildArguments(
    request: ProviderReviewRequest,
    workspace: string,
    schemaPath: string,
    _schemaJson: string,
    outputPath: string,
  ): readonly string[] {
    return [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-c",
      "shell_environment_policy.inherit=none",
      "--color",
      "never",
      "--json",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--model",
      request.model,
      "-C",
      workspace,
      "-",
    ];
  }

  protected parseResponse(
    output: ProcessProviderOutput,
    request: ProviderReviewRequest,
  ): ProviderReviewResponse {
    const text = output.lastMessage.toString("utf8").trim();
    if (text.length === 0) {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Codex provider returned an empty response",
      );
    }
    let content: unknown;
    try {
      content = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Codex provider returned invalid JSON",
      );
    }

    let providerRequestId = request.runId;
    let usage = null;
    for (const line of output.stdout.toString("utf8").split("\n")) {
      const event = parseMetadataEvent(line);
      if (event === undefined) continue;
      if (
        event.type === "thread.started" &&
        typeof event.thread_id === "string"
      ) {
        providerRequestId = event.thread_id;
      }
      if (event.type === "turn.completed") {
        usage = parseProviderUsage(event.usage, {
          input: "input_tokens",
          output: "output_tokens",
          total: "total_tokens",
        });
      }
    }
    return {
      content,
      usage,
      finishReason: "stop",
      rawFinishReason: null,
      providerRequestId,
      truncated: false,
      attemptsUsed: 1,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMetadataEvent(line: string): Record<string, unknown> | undefined {
  if (line.trim().length === 0) return undefined;
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
