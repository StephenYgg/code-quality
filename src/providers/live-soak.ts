import type { UserConfig, UserProviderConfig } from "../core/user-config.js";
import { cancelResponseBody } from "./bounded-response.js";
import { ClaudeCliProvider } from "./claude-cli.js";
import { CodexCliProvider } from "./codex-cli.js";
import {
  type ProviderDiagnostic,
  type ProviderReviewRequest,
  type ReviewProvider,
} from "./provider.js";
import { resolveProviderFromUserConfig } from "./resolve.js";

/**
 * Opt-in live soak: may contact configured providers/forges.
 * Never sends repository source content — only synthetic ping payloads.
 * Enabled by CQ_PROVIDER_LIVE_SOAK=1 or explicit live: true.
 */
export function isLiveSoakEnabled(env?: NodeJS.ProcessEnv): boolean {
  const value = (env ?? process.env).CQ_PROVIDER_LIVE_SOAK?.trim();
  return value === "1" || value?.toLowerCase() === "true";
}

export interface LiveSoakResult {
  readonly live: true;
  readonly ok: boolean;
  readonly diagnostics: readonly ProviderDiagnostic[];
  readonly detail?: string;
}

const SYNTHETIC_RESPONSE = Object.freeze({
  ok: true,
  ping: "cq-live-soak",
});
const SYNTHETIC_PING = `Respond with exactly: ${JSON.stringify(SYNTHETIC_RESPONSE)}`;
const SYNTHETIC_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["ok", "ping"],
  properties: {
    ok: { const: true },
    ping: { const: "cq-live-soak" },
  },
});

function syntheticRequest(
  model: string,
  timeoutMs: number,
): ProviderReviewRequest {
  return {
    runId: "cq-live-soak",
    stageId: "synthetic-connectivity",
    model,
    systemInstructions: SYNTHETIC_PING,
    untrustedContext: [],
    outputSchema: SYNTHETIC_SCHEMA,
    maxOutputTokens: 64,
    timeoutMs,
    maxRequestBytes: 32 * 1024,
    maxResponseBytes: 32 * 1024,
    maxDiagnosticBytes: 8 * 1024,
    signal: new AbortController().signal,
    attemptBudget: { maxAttempts: 1, used: 0 },
  };
}

function isExpectedSyntheticResponse(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.ok === true &&
    record.ping === "cq-live-soak"
  );
}

async function runSyntheticSoak(
  provider: ReviewProvider,
  model: string,
  timeoutMs: number,
): Promise<LiveSoakResult> {
  try {
    const response = await provider.review(syntheticRequest(model, timeoutMs));
    if (!isExpectedSyntheticResponse(response.content)) {
      return {
        live: true,
        ok: false,
        diagnostics: [
          {
            code: "LIVE_SOAK_RESPONSE_INVALID",
            message:
              "Live provider soak returned an unexpected synthetic response",
          },
        ],
      };
    }
    return {
      live: true,
      ok: true,
      diagnostics: [],
      detail: "Provider returned the expected bounded synthetic response",
    };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : error;
    return {
      live: true,
      ok: false,
      diagnostics: [
        {
          code: "LIVE_SOAK_FAILED",
          message: provider.redactDiagnostic(diagnostic),
        },
      ],
    };
  }
}

export async function liveSoakProcessProvider(
  provider: UserProviderConfig,
  timeoutMs = 20_000,
): Promise<LiveSoakResult> {
  if (provider.kind !== "codex_cli" && provider.kind !== "claude_cli") {
    return {
      live: true,
      ok: false,
      diagnostics: [
        {
          code: "LIVE_SOAK_UNSUPPORTED",
          message: "Live process soak only supports codex_cli and claude_cli",
        },
      ],
    };
  }
  const reviewProvider =
    provider.kind === "codex_cli"
      ? new CodexCliProvider({
          executable: provider.executable,
          model: provider.defaultModel,
          allowedModels: provider.allowedModels,
        })
      : new ClaudeCliProvider({
          executable: provider.executable,
          model: provider.defaultModel,
          allowedModels: provider.allowedModels,
        });
  return runSyntheticSoak(reviewProvider, provider.defaultModel, timeoutMs);
}

export async function liveSoakHttpProvider(
  config: UserConfig,
  provider: UserProviderConfig,
  options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<LiveSoakResult> {
  try {
    const resolved = resolveProviderFromUserConfig(config, {
      providerName: provider.name,
      ...(options?.env === undefined ? {} : { env: options.env }),
      ...(options?.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
    });
    return await runSyntheticSoak(resolved.provider, resolved.model, 20_000);
  } catch (error) {
    return {
      live: true,
      ok: false,
      diagnostics: [
        {
          code: "LIVE_SOAK_FAILED",
          message:
            error instanceof Error ? error.message : "HTTP live soak failed",
        },
      ],
    };
  }
}

/**
 * Probe forge token without writing: GET api.github.com/rate_limit or
 * GitLab /api/v4/user. Never logs the token value.
 */
export async function liveSoakForgeToken(options: {
  readonly tokenEnv: string;
  readonly forge: "github" | "gitlab";
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}): Promise<LiveSoakResult> {
  const env = options.env ?? process.env;
  const name = options.tokenEnv;
  const token = env[name]?.trim();
  if (token === undefined || token.length === 0) {
    return {
      live: true,
      ok: false,
      diagnostics: [
        {
          code: "FORGE_TOKEN_MISSING",
          message: `Environment variable ${name} is not set`,
        },
      ],
    };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url =
    options.forge === "github"
      ? "https://api.github.com/rate_limit"
      : "https://gitlab.com/api/v4/user";
  const headers: Record<string, string> =
    options.forge === "github"
      ? {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "code-quality-live-soak",
        }
      : {
          "PRIVATE-TOKEN": token,
          "User-Agent": "code-quality-live-soak",
        };
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    cancelResponseBody(
      response,
      response.ok
        ? "forge token probe completed"
        : "forge token probe rejected",
    );
    if (response.ok) {
      return {
        live: true,
        ok: true,
        diagnostics: [],
        detail: `Forge token accepted by ${options.forge} (read-only probe)`,
      };
    }
  } catch {
    // Return the bounded diagnostic below without trying another forge.
  }
  return {
    live: true,
    ok: false,
    diagnostics: [
      {
        code: "FORGE_TOKEN_REJECTED",
        message: `Token in ${name} was not accepted by the ${options.forge} read-only probe endpoint`,
      },
    ],
  };
}
