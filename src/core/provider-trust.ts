import type {
  PolicyDiagnostic,
  ProviderSelection,
  TrustedProviderDefinition,
} from "./policy-types.js";

const MAX_TRUSTED_PROVIDERS = 64;
const MAX_ALLOWED_PROVIDER_SELECTIONS = 128;
const PROVIDER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u;
const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/u;

function diagnostic(
  code: string,
  message: string,
  path = "/provider",
): PolicyDiagnostic {
  return { code, source: "trusted-provider-catalog", path, message };
}

function validateCatalogEntry(
  entry: TrustedProviderDefinition,
  index: number,
): readonly PolicyDiagnostic[] {
  const sourcePath = `/trustedProviders/${String(index)}`;
  const diagnostics: PolicyDiagnostic[] = [];
  if (!PROVIDER_NAME.test(entry.name)) {
    diagnostics.push(
      diagnostic(
        "PROVIDER_CATALOG_INVALID",
        "Trusted provider name is invalid",
        `${sourcePath}/name`,
      ),
    );
  }
  for (const [key, values] of [
    ["allowedModels", entry.allowedModels],
    ["allowedModelPolicies", entry.allowedModelPolicies],
  ] as const) {
    if (values.length > MAX_ALLOWED_PROVIDER_SELECTIONS) {
      diagnostics.push(
        diagnostic(
          "PROVIDER_CATALOG_INVALID",
          `Trusted provider ${key} exceeds ${String(MAX_ALLOWED_PROVIDER_SELECTIONS)} entries`,
          `${sourcePath}/${key}`,
        ),
      );
    }
    if (
      new Set(values).size !== values.length ||
      values.some((value) => !MODEL_NAME.test(value))
    ) {
      diagnostics.push(
        diagnostic(
          "PROVIDER_CATALOG_INVALID",
          `Trusted provider ${key} must contain unique bounded names`,
          `${sourcePath}/${key}`,
        ),
      );
    }
  }
  return diagnostics;
}

export function validateTrustedProviderSelection(
  selection: ProviderSelection | undefined,
  catalog: readonly TrustedProviderDefinition[] | undefined,
): readonly PolicyDiagnostic[] {
  if (selection === undefined) {
    return [];
  }
  if (catalog === undefined || catalog.length === 0) {
    return [
      diagnostic(
        "PROVIDER_CATALOG_REQUIRED",
        "A provider selection requires an explicit trusted provider catalog",
      ),
    ];
  }
  if (catalog.length > MAX_TRUSTED_PROVIDERS) {
    return [
      diagnostic(
        "PROVIDER_CATALOG_INVALID",
        `Trusted provider catalog exceeds ${String(MAX_TRUSTED_PROVIDERS)} entries`,
        "/trustedProviders",
      ),
    ];
  }
  const diagnostics = catalog.flatMap((entry, index) =>
    validateCatalogEntry(entry, index),
  );
  const providerNames = catalog.map((entry) => entry.name);
  if (new Set(providerNames).size !== providerNames.length) {
    diagnostics.push(
      diagnostic(
        "PROVIDER_CATALOG_INVALID",
        "Trusted provider names must be unique",
        "/trustedProviders",
      ),
    );
  }
  if (diagnostics.length > 0) {
    return diagnostics;
  }
  const trusted = catalog.find((entry) => entry.name === selection.name);
  if (trusted === undefined) {
    return [
      diagnostic(
        "PROVIDER_NOT_TRUSTED",
        `Provider ${selection.name} is not present in the trusted catalog`,
      ),
    ];
  }
  const selectsModel = selection.model !== undefined;
  const selectsPolicy = selection.modelPolicy !== undefined;
  if (selectsModel === selectsPolicy) {
    return [
      diagnostic(
        "PROVIDER_MODEL_SELECTION_INVALID",
        "Provider selection must choose exactly one model or model policy",
      ),
    ];
  }
  if (
    selection.model !== undefined &&
    !trusted.allowedModels.includes(selection.model)
  ) {
    return [
      diagnostic(
        "PROVIDER_MODEL_NOT_ALLOWED",
        `Model ${selection.model} is not allowed for provider ${selection.name}`,
      ),
    ];
  }
  if (
    selection.modelPolicy !== undefined &&
    !trusted.allowedModelPolicies.includes(selection.modelPolicy)
  ) {
    return [
      diagnostic(
        "PROVIDER_MODEL_POLICY_NOT_ALLOWED",
        `Model policy ${selection.modelPolicy} is not allowed for provider ${selection.name}`,
      ),
    ];
  }
  return [];
}
