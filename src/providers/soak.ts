import {
  loadUserConfig,
  type UserConfig,
  type UserProviderConfig,
} from "../core/user-config.js";
import {
  isLiveSoakEnabled,
  liveSoakForgeToken,
  liveSoakHttpProvider,
  liveSoakProcessProvider,
  type LiveSoakResult,
} from "./live-soak.js";
import {
  CLAUDE_REQUIRED_FLAGS,
  CODEX_REQUIRED_FLAGS,
  probeProcessProviderResult,
  probeProcessVersion,
} from "./probe.js";
import { resolveProviderFromUserConfig } from "./resolve.js";
import type { ProviderDiagnostic } from "./provider.js";

export interface ProviderSoakEntry {
  readonly name: string;
  readonly kind: UserProviderConfig["kind"] | "forge_token";
  readonly ok: boolean;
  readonly version?: string;
  readonly adapterVersion: string;
  readonly diagnostics: readonly ProviderDiagnostic[];
  readonly probedAt: string;
  readonly live?: LiveSoakResult;
}

export interface ProviderSoakReport {
  readonly configPath: string;
  readonly entries: readonly ProviderSoakEntry[];
  readonly ok: boolean;
  readonly probedAt: string;
  readonly liveEnabled: boolean;
}

export const PROVIDER_ADAPTER_VERSION = "cq-provider-adapter/v1";

export async function captureProcessVersion(
  executable: string,
  timeoutMs = 3_000,
): Promise<string | undefined> {
  const result = await probeProcessVersion({ executable, timeoutMs });
  return result.terminal === undefined && result.diagnostics.length === 0
    ? result.version
    : undefined;
}

async function soakOne(
  config: UserConfig,
  provider: UserProviderConfig,
  live: boolean,
  env: NodeJS.ProcessEnv,
): Promise<ProviderSoakEntry> {
  const probedAt = new Date().toISOString();
  if (provider.kind === "codex_cli" || provider.kind === "claude_cli") {
    const flags =
      provider.kind === "codex_cli"
        ? CODEX_REQUIRED_FLAGS
        : CLAUDE_REQUIRED_FLAGS;
    const probe = await probeProcessProviderResult({
      kind: provider.kind,
      executable: provider.executable,
      requiredFlags: flags,
    });
    const diagnostics =
      probe.terminal === undefined
        ? probe.diagnostics
        : [
            {
              code:
                probe.terminal === "aborted"
                  ? "PROVIDER_PROBE_ABORTED"
                  : "PROVIDER_PROBE_TIMEOUT",
              message:
                probe.terminal === "aborted"
                  ? "Provider probe was cancelled"
                  : "Provider probe timed out",
              path: "/executable",
            },
          ];
    const version = probe.version;
    let liveResult: LiveSoakResult | undefined;
    if (live && diagnostics.length === 0) {
      liveResult = await liveSoakProcessProvider(provider);
    }
    const ok =
      diagnostics.length === 0 && (liveResult === undefined || liveResult.ok);
    return {
      name: provider.name,
      kind: provider.kind,
      ok,
      ...(version === undefined ? {} : { version }),
      adapterVersion: PROVIDER_ADAPTER_VERSION,
      diagnostics: [...diagnostics, ...(liveResult?.diagnostics ?? [])],
      probedAt,
      ...(liveResult === undefined ? {} : { live: liveResult }),
    };
  }

  try {
    const resolved = resolveProviderFromUserConfig(config, {
      providerName: provider.name,
      env,
    });
    const diagnostics = await resolved.provider.validateConfiguration();
    let liveResult: LiveSoakResult | undefined;
    if (live && diagnostics.length === 0) {
      liveResult = await liveSoakHttpProvider(config, provider, { env });
    }
    const ok =
      diagnostics.length === 0 && (liveResult === undefined || liveResult.ok);
    return {
      name: provider.name,
      kind: provider.kind,
      ok,
      adapterVersion: PROVIDER_ADAPTER_VERSION,
      diagnostics: [...diagnostics, ...(liveResult?.diagnostics ?? [])],
      probedAt,
      ...(liveResult === undefined ? {} : { live: liveResult }),
    };
  } catch (error) {
    return {
      name: provider.name,
      kind: provider.kind,
      ok: false,
      adapterVersion: PROVIDER_ADAPTER_VERSION,
      diagnostics: [
        {
          code: "PROVIDER_SOAK_FAILED",
          message:
            error instanceof Error ? error.message : "Provider soak failed",
        },
      ],
      probedAt,
    };
  }
}

/**
 * Production-oriented soak without sending repository content:
 * probes local CLIs for safe-mode flags/version and validates HTTP provider config.
 * Live model/forge calls are opt-in via live:true or CQ_PROVIDER_LIVE_SOAK=1.
 */
export async function soakUserProviders(options?: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly live?: boolean;
  readonly forgeTokenEnv?: string;
  readonly forge?: "github" | "gitlab";
  readonly forgeFetchImpl?: typeof fetch;
  readonly skipProviders?: boolean;
}): Promise<ProviderSoakReport> {
  const env = options?.env ?? process.env;
  const live = options?.live === true || isLiveSoakEnabled(env);
  const config = await loadUserConfig({
    ...(options?.configPath === undefined ? {} : { path: options.configPath }),
    env,
  });
  const entries: ProviderSoakEntry[] = [];
  if (options?.skipProviders !== true) {
    for (const provider of config.providers) {
      entries.push(await soakOne(config, provider, live, env));
    }
  }
  const hasTokenEnv = options?.forgeTokenEnv !== undefined;
  const hasForge = options?.forge !== undefined;
  if (live && hasTokenEnv && hasForge) {
    const forge = await liveSoakForgeToken({
      tokenEnv: options.forgeTokenEnv,
      forge: options.forge,
      env,
      ...(options.forgeFetchImpl === undefined
        ? {}
        : { fetchImpl: options.forgeFetchImpl }),
    });
    entries.push({
      name: options.forgeTokenEnv,
      kind: "forge_token",
      ok: forge.ok,
      adapterVersion: PROVIDER_ADAPTER_VERSION,
      diagnostics: forge.diagnostics,
      probedAt: new Date().toISOString(),
      live: forge,
    });
  } else if (live && hasTokenEnv !== hasForge) {
    const diagnostic = {
      code: "FORGE_PROBE_CONFIG_INVALID",
      message:
        "Live forge probe requires both an explicit forge and token environment variable",
    };
    entries.push({
      name: options?.forgeTokenEnv ?? options?.forge ?? "forge",
      kind: "forge_token",
      ok: false,
      adapterVersion: PROVIDER_ADAPTER_VERSION,
      diagnostics: [diagnostic],
      probedAt: new Date().toISOString(),
      live: {
        live: true,
        ok: false,
        diagnostics: [diagnostic],
      },
    });
  }
  return {
    configPath: config.sourcePath,
    entries: Object.freeze(entries),
    ok: entries.every((entry) => entry.ok),
    probedAt: new Date().toISOString(),
    liveEnabled: live,
  };
}
