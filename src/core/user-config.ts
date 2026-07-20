import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseDocument } from "yaml";

import type { ProviderKind } from "../providers/provider.js";
import type { TrustedProviderDefinition } from "./policy-types.js";

export const USER_CONFIG_SCHEMA_VERSION = "1" as const;
export const MAX_USER_PROVIDERS = 32;
export const MAX_USER_CONFIG_BYTES = 1024 * 1024;

export type UserProviderKind = ProviderKind;

export interface UserProcessProviderConfig {
  readonly name: string;
  readonly kind: "codex_cli" | "claude_cli";
  readonly executable: string;
  readonly allowedModels: readonly string[];
  readonly defaultModel: string;
}

export interface UserHttpProviderConfig {
  readonly name: string;
  readonly kind: "openai_compatible" | "anthropic_compatible";
  readonly endpoint: string;
  readonly credentialEnv: string;
  readonly allowedModels: readonly string[];
  readonly defaultModel: string;
  readonly allowLoopbackHttp?: boolean;
}

export type UserProviderConfig =
  UserProcessProviderConfig | UserHttpProviderConfig;

export interface UserConfig {
  readonly schemaVersion: typeof USER_CONFIG_SCHEMA_VERSION;
  readonly defaultProvider?: string;
  readonly providers: readonly UserProviderConfig[];
  readonly sourcePath: string;
}

export class UserConfigError extends Error {
  constructor(
    readonly code:
      | "USER_CONFIG_MISSING"
      | "USER_CONFIG_INVALID"
      | "USER_CONFIG_PROVIDER_UNKNOWN"
      | "USER_CONFIG_MODEL_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "UserConfigError";
  }
}

const PROVIDER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u;
const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;

export function platformConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.CQ_CONFIG_DIR !== undefined && env.CQ_CONFIG_DIR.length > 0) {
    return env.CQ_CONFIG_DIR;
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "code-quality");
  }
  if (process.platform === "win32") {
    const base = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "code-quality");
  }
  const xdg = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "code-quality");
}

export function defaultUserConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.CQ_CONFIG_PATH !== undefined && env.CQ_CONFIG_PATH.length > 0) {
    return env.CQ_CONFIG_PATH;
  }
  return join(platformConfigDirectory(env), "config.yaml");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      `${field} must be an array of strings`,
    );
  }
  return value.map((item) => String(item));
}

function parseProvider(value: unknown, index: number): UserProviderConfig {
  if (!isRecord(value)) {
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      `providers[${String(index)}] must be an object`,
    );
  }
  const name = value.name;
  const kind = value.kind;
  const defaultModel = value.defaultModel;
  const allowedModels = asStringArray(
    value.allowedModels,
    `providers[${String(index)}].allowedModels`,
  );
  if (typeof name !== "string" || !PROVIDER_NAME.test(name)) {
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      `providers[${String(index)}].name is invalid`,
    );
  }
  if (typeof defaultModel !== "string" || !MODEL_NAME.test(defaultModel)) {
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      `providers[${String(index)}].defaultModel is invalid`,
    );
  }
  if (
    allowedModels.length === 0 ||
    allowedModels.length > 128 ||
    new Set(allowedModels).size !== allowedModels.length ||
    allowedModels.some((model) => !MODEL_NAME.test(model))
  ) {
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      `providers[${String(index)}].allowedModels is invalid`,
    );
  }
  if (!allowedModels.includes(defaultModel)) {
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      `providers[${String(index)}].defaultModel is not in allowedModels`,
    );
  }
  if (kind === "codex_cli" || kind === "claude_cli") {
    const executable = value.executable;
    if (typeof executable !== "string" || !isAbsolute(executable)) {
      throw new UserConfigError(
        "USER_CONFIG_INVALID",
        `providers[${String(index)}].executable must be an absolute path`,
      );
    }
    return {
      name,
      kind,
      executable,
      allowedModels,
      defaultModel,
    };
  }
  if (kind === "openai_compatible" || kind === "anthropic_compatible") {
    const endpoint = value.endpoint;
    const credentialEnv = value.credentialEnv;
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      throw new UserConfigError(
        "USER_CONFIG_INVALID",
        `providers[${String(index)}].endpoint is invalid`,
      );
    }
    if (typeof credentialEnv !== "string" || !ENV_NAME.test(credentialEnv)) {
      throw new UserConfigError(
        "USER_CONFIG_INVALID",
        `providers[${String(index)}].credentialEnv is invalid`,
      );
    }
    return {
      name,
      kind,
      endpoint,
      credentialEnv,
      allowedModels,
      defaultModel,
      ...(value.allowLoopbackHttp === true ? { allowLoopbackHttp: true } : {}),
    };
  }
  throw new UserConfigError(
    "USER_CONFIG_INVALID",
    `providers[${String(index)}].kind is unsupported`,
  );
}

export function parseUserConfigDocument(
  data: unknown,
  sourcePath: string,
): UserConfig {
  if (!isRecord(data)) {
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      "User config root must be an object",
    );
  }
  if (data.schemaVersion !== USER_CONFIG_SCHEMA_VERSION) {
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      'User config schemaVersion must be "1"',
    );
  }
  if (!Array.isArray(data.providers)) {
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      "User config providers must be an array",
    );
  }
  if (
    data.providers.length === 0 ||
    data.providers.length > MAX_USER_PROVIDERS
  ) {
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      `User config providers must contain 1 to ${String(MAX_USER_PROVIDERS)} entries`,
    );
  }
  const providers = data.providers.map((entry, index) =>
    parseProvider(entry, index),
  );
  const names = providers.map((provider) => provider.name);
  if (new Set(names).size !== names.length) {
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      "User config provider names must be unique",
    );
  }
  let defaultProvider: string | undefined;
  if (data.defaultProvider !== undefined) {
    if (
      typeof data.defaultProvider !== "string" ||
      !names.includes(data.defaultProvider)
    ) {
      throw new UserConfigError(
        "USER_CONFIG_INVALID",
        "User config defaultProvider must name a configured provider",
      );
    }
    defaultProvider = data.defaultProvider;
  }
  return Object.freeze({
    schemaVersion: USER_CONFIG_SCHEMA_VERSION,
    ...(defaultProvider === undefined ? {} : { defaultProvider }),
    providers: Object.freeze(
      providers.map((provider) => Object.freeze(provider)),
    ),
    sourcePath,
  });
}

export async function loadUserConfig(options?: {
  readonly path?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<UserConfig> {
  const env = options?.env ?? process.env;
  const path = options?.path ?? defaultUserConfigPath(env);
  try {
    await access(path);
  } catch {
    throw new UserConfigError(
      "USER_CONFIG_MISSING",
      `Trusted user config not found at ${path}. Create config.yaml with provider definitions outside the reviewed repository.`,
    );
  }
  const absolutePath = await realpath(path);
  const text = await readFile(absolutePath, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_USER_CONFIG_BYTES) {
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      "User config exceeds the 1 MiB hard limit",
    );
  }
  try {
    const document = parseDocument(text, {
      prettyErrors: true,
      strict: true,
    });
    if (document.errors.length > 0) {
      throw new UserConfigError(
        "USER_CONFIG_INVALID",
        "User config YAML is invalid",
      );
    }
    const data = document.toJS() as unknown;
    return parseUserConfigDocument(data, absolutePath);
  } catch (error) {
    if (error instanceof UserConfigError) throw error;
    throw new UserConfigError(
      "USER_CONFIG_INVALID",
      "User config could not be parsed",
    );
  }
}

export function selectUserProvider(
  config: UserConfig,
  options?: {
    readonly providerName?: string;
    readonly model?: string;
  },
): {
  readonly provider: UserProviderConfig;
  readonly model: string;
} {
  const name =
    options?.providerName ??
    config.defaultProvider ??
    config.providers[0]?.name;
  if (name === undefined) {
    throw new UserConfigError(
      "USER_CONFIG_PROVIDER_UNKNOWN",
      "No provider is configured",
    );
  }
  const provider = config.providers.find((entry) => entry.name === name);
  if (provider === undefined) {
    throw new UserConfigError(
      "USER_CONFIG_PROVIDER_UNKNOWN",
      `Provider ${name} is not present in trusted user config`,
    );
  }
  const model = options?.model ?? provider.defaultModel;
  if (!provider.allowedModels.includes(model)) {
    throw new UserConfigError(
      "USER_CONFIG_MODEL_INVALID",
      `Model ${model} is not allowed for provider ${provider.name}`,
    );
  }
  return { provider, model };
}

export function userConfigToTrustedCatalog(
  config: UserConfig,
): readonly TrustedProviderDefinition[] {
  return Object.freeze(
    config.providers.map((provider) =>
      Object.freeze({
        name: provider.name,
        allowedModels: provider.allowedModels,
        allowedModelPolicies: Object.freeze([] as string[]),
      }),
    ),
  );
}
