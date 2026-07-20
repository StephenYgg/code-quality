export type ProviderKind =
  "codex_cli" | "claude_cli" | "openai_compatible" | "anthropic_compatible";

export type ProviderTransport = "process" | "http";

export interface ProviderCapabilities {
  readonly kind: ProviderKind;
  readonly transport: ProviderTransport;
  readonly structuredOutput: "native_json_schema" | "prompt_json";
  readonly isolation: "no_tools" | "read_only_sandbox";
  readonly usage: "reported" | "unavailable";
  readonly finishReason: "reported" | "derived" | "unavailable";
  readonly requestId: "reported" | "execution_id" | "unavailable";
  readonly cancellation: true;
}

export interface ProviderDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface ContextPart {
  readonly role: "system" | "user" | "untrusted";
  readonly label: string;
  readonly text: string;
}

export interface ProviderAttemptBudget {
  readonly maxAttempts: 1 | 2;
  readonly used: number;
}

export interface ProviderReviewRequest {
  readonly runId: string;
  readonly stageId: string;
  readonly model: string;
  readonly systemInstructions: string;
  readonly untrustedContext: readonly ContextPart[];
  readonly outputSchema: unknown;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxDiagnosticBytes: number;
  readonly signal: AbortSignal;
  readonly attemptBudget: ProviderAttemptBudget;
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export type ProviderFinishReason =
  "stop" | "length" | "content_filter" | "refusal" | "unknown";

export interface ProviderReviewResponse {
  readonly content: unknown;
  readonly usage: ProviderUsage | null;
  readonly finishReason: ProviderFinishReason;
  readonly rawFinishReason: string | null;
  readonly providerRequestId: string | null;
  readonly truncated: boolean;
  readonly attemptsUsed: 1 | 2;
}

export interface ReviewProviderSession {
  release(): Promise<void>;
}

export interface ReviewProviderSessionOptions {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export type ProviderErrorCode =
  | "PROVIDER_CONFIG_INVALID"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ABORTED"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_RESPONSE_TOO_LARGE"
  | "PROVIDER_NETWORK"
  | "PROVIDER_CAPACITY"
  | "PROVIDER_UNSAFE"
  | "PROVIDER_FAILED";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ReviewProvider {
  capabilities(): ProviderCapabilities;
  validateConfiguration(): Promise<readonly ProviderDiagnostic[]>;
  openReviewSession?(
    options: ReviewProviderSessionOptions,
  ): Promise<ReviewProviderSession>;
  review(request: ProviderReviewRequest): Promise<ProviderReviewResponse>;
  redactDiagnostic(value: unknown): string;
}

export interface ProcessProviderConfig {
  readonly kind: "codex_cli" | "claude_cli";
  readonly executable: string;
  readonly model: string;
  readonly allowedModels: readonly string[];
}

export interface HttpProviderConfig {
  readonly kind: "openai_compatible" | "anthropic_compatible";
  readonly endpoint: string;
  readonly model: string;
  readonly allowedModels: readonly string[];
  readonly credentialEnv: string;
  readonly allowLoopbackHttp?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

export function freezeCapabilities(
  capabilities: ProviderCapabilities,
): ProviderCapabilities {
  return Object.freeze({ ...capabilities });
}

export function redactSecrets(
  value: unknown,
  secrets: readonly string[],
): string {
  let text = typeof value === "string" ? value : safeJson(value);
  for (const secret of secrets) {
    if (secret.length >= 8) {
      text = text.split(secret).join("[REDACTED]");
    }
  }
  return text.replace(/(Bearer\s+)[A-Za-z0-9._-]+/giu, "$1[REDACTED]");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export function validateModelAllowlist(
  model: string,
  allowed: readonly string[],
): ProviderDiagnostic[] {
  if (!allowed.includes(model)) {
    return [
      {
        code: "PROVIDER_MODEL_NOT_ALLOWED",
        message: "Model is not present in the trusted allowlist",
        path: "/model",
      },
    ];
  }
  return [];
}

export function assertAbsoluteExecutable(path: string): ProviderDiagnostic[] {
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(path)) {
    return [
      {
        code: "PROVIDER_EXECUTABLE_INVALID",
        message: "Provider executable must be an absolute path",
        path: "/executable",
      },
    ];
  }
  return [];
}

export function assertTrustedEndpoint(
  endpoint: string,
  allowLoopbackHttp: boolean,
): ProviderDiagnostic[] {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return [
      {
        code: "PROVIDER_ENDPOINT_INVALID",
        message: "Provider endpoint is not a valid URL",
        path: "/endpoint",
      },
    ];
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol === "https:") return [];
  if (url.protocol === "http:" && allowLoopbackHttp && loopback) return [];
  return [
    {
      code: "PROVIDER_ENDPOINT_INSECURE",
      message: "Provider endpoint must use HTTPS except explicit loopback HTTP",
      path: "/endpoint",
    },
  ];
}
