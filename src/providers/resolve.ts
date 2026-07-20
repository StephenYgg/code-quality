import { createHash } from "node:crypto";

import { ClaudeCliProvider } from "./claude-cli.js";
import { CodexCliProvider } from "./codex-cli.js";
import { AnthropicCompatibleProvider } from "./anthropic-compatible.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import type { ReviewProvider } from "./provider.js";
import {
  loadUserConfig,
  selectUserProvider,
  UserConfigError,
  type UserConfig,
  type UserProviderConfig,
} from "../core/user-config.js";
import { canonicalizePolicy } from "../core/policy-values.js";

export interface ResolvedReviewProvider {
  readonly provider: ReviewProvider;
  readonly providerName: string;
  readonly kind: UserProviderConfig["kind"];
  readonly model: string;
  readonly providerClass: string;
  readonly endpointClass: string;
  readonly egressClass: "local" | "https" | "loopback";
  readonly egressPolicy: string;
  readonly trustedConfigIdentity: string;
  readonly endpointIdentity: string;
  readonly configPath: string;
}

export class ProviderResolveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderResolveError";
  }
}

function createProviderInstance(
  definition: UserProviderConfig,
  model: string,
  options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly fetchImpl?: typeof fetch;
  },
): ReviewProvider {
  switch (definition.kind) {
    case "codex_cli":
      return new CodexCliProvider({
        executable: definition.executable,
        model,
        allowedModels: definition.allowedModels,
      });
    case "claude_cli":
      return new ClaudeCliProvider({
        executable: definition.executable,
        model,
        allowedModels: definition.allowedModels,
      });
    case "openai_compatible":
      return new OpenAiCompatibleProvider({
        endpoint: definition.endpoint,
        model,
        allowedModels: definition.allowedModels,
        credentialEnv: definition.credentialEnv,
        ...(definition.allowLoopbackHttp === true
          ? { allowLoopbackHttp: true }
          : {}),
        ...(options?.env === undefined ? {} : { env: options.env }),
        ...(options?.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetchImpl }),
      });
    case "anthropic_compatible":
      return new AnthropicCompatibleProvider({
        endpoint: definition.endpoint,
        model,
        allowedModels: definition.allowedModels,
        credentialEnv: definition.credentialEnv,
        ...(definition.allowLoopbackHttp === true
          ? { allowLoopbackHttp: true }
          : {}),
        ...(options?.env === undefined ? {} : { env: options.env }),
        ...(options?.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetchImpl }),
      });
    default: {
      const exhaustive: never = definition;
      return exhaustive;
    }
  }
}

function classifyEgress(
  definition: UserProviderConfig,
): ResolvedReviewProvider["egressClass"] {
  switch (definition.kind) {
    case "codex_cli":
    case "claude_cli":
      return "local";
    case "openai_compatible":
    case "anthropic_compatible": {
      try {
        const url = new URL(definition.endpoint);
        const loopback =
          url.hostname === "localhost" ||
          url.hostname === "127.0.0.1" ||
          url.hostname === "::1";
        if (loopback) return "loopback";
        return "https";
      } catch {
        return "https";
      }
    }
    default: {
      const exhaustive: never = definition;
      return exhaustive;
    }
  }
}

function identityHash(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0`, "utf8")
    .update(canonicalizePolicy(value), "utf8")
    .digest("hex");
}

function endpointValue(definition: UserProviderConfig): string {
  switch (definition.kind) {
    case "codex_cli":
    case "claude_cli":
      return definition.executable;
    case "openai_compatible":
    case "anthropic_compatible":
      return definition.endpoint;
    default: {
      const exhaustive: never = definition;
      return exhaustive;
    }
  }
}

function egressPolicy(definition: UserProviderConfig): string {
  switch (definition.kind) {
    case "codex_cli":
    case "claude_cli":
      return "local-process-only/v1";
    case "openai_compatible":
    case "anthropic_compatible":
      return definition.allowLoopbackHttp === true
        ? "https-or-explicit-loopback/v1"
        : "https-only/v1";
    default: {
      const exhaustive: never = definition;
      return exhaustive;
    }
  }
}

export function resolveProviderFromUserConfig(
  config: UserConfig,
  options?: {
    readonly providerName?: string;
    readonly model?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly fetchImpl?: typeof fetch;
  },
): ResolvedReviewProvider {
  try {
    const selected = selectUserProvider(config, options);
    const instance = createProviderInstance(selected.provider, selected.model, {
      ...(options?.env === undefined ? {} : { env: options.env }),
      ...(options?.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
    });
    return Object.freeze({
      provider: instance,
      providerName: selected.provider.name,
      kind: selected.provider.kind,
      model: selected.model,
      providerClass: selected.provider.kind,
      endpointClass:
        selected.provider.kind === "codex_cli" ||
        selected.provider.kind === "claude_cli"
          ? "process"
          : "http",
      egressClass: classifyEgress(selected.provider),
      egressPolicy: egressPolicy(selected.provider),
      trustedConfigIdentity: identityHash(
        "cq-trusted-provider-config/v1",
        selected.provider,
      ),
      endpointIdentity: identityHash(
        "cq-provider-endpoint/v1",
        endpointValue(selected.provider),
      ),
      configPath: config.sourcePath,
    });
  } catch (error) {
    if (error instanceof UserConfigError) {
      throw new ProviderResolveError(error.code, error.message);
    }
    throw error;
  }
}

export async function resolveReviewProvider(options?: {
  readonly configPath?: string;
  readonly providerName?: string;
  readonly model?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly injected?: ReviewProvider;
}): Promise<ResolvedReviewProvider> {
  if (options?.injected !== undefined) {
    const capabilities = options.injected.capabilities();
    return Object.freeze({
      provider: options.injected,
      providerName: "injected",
      kind: "codex_cli",
      model: options.model ?? "default",
      providerClass: "injected",
      endpointClass: "test",
      egressClass: "local",
      egressPolicy: "trusted-injected-local/v1",
      trustedConfigIdentity: identityHash(
        "cq-injected-provider/v1",
        capabilities,
      ),
      endpointIdentity: identityHash("cq-injected-provider-endpoint/v1", {
        transport: capabilities.transport,
        isolation: capabilities.isolation,
      }),
      configPath: "injected",
    });
  }
  try {
    const config = await loadUserConfig({
      ...(options?.configPath === undefined
        ? {}
        : { path: options.configPath }),
      ...(options?.env === undefined ? {} : { env: options.env }),
    });
    return resolveProviderFromUserConfig(config, {
      ...(options?.providerName === undefined
        ? {}
        : { providerName: options.providerName }),
      ...(options?.model === undefined ? {} : { model: options.model }),
      ...(options?.env === undefined ? {} : { env: options.env }),
    });
  } catch (error) {
    if (error instanceof UserConfigError) {
      throw new ProviderResolveError(error.code, error.message);
    }
    if (error instanceof ProviderResolveError) throw error;
    throw new ProviderResolveError(
      "USER_CONFIG_INVALID",
      "Provider configuration could not be resolved",
    );
  }
}
