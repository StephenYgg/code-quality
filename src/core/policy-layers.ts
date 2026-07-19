import { join, relative } from "node:path";

import { StructuredConfigError, type StructuredReadBudget } from "./config.js";
import { PolicyDiagnosticCollector } from "./policy-diagnostics.js";
import {
  POLICY_PROJECT_ROOT,
  configDiagnostic,
  loadPolicyDocument,
  validatePolicyLayer,
} from "./policy-schema.js";
import type {
  PolicyLayer,
  PolicyDiagnostic,
  PolicySource,
  ProfileDocument,
  ResolvePolicyRequest,
} from "./policy-types.js";
import {
  applySafetyInvariants,
  filePolicySource,
  inlinePolicySource,
  mergePolicyLayer,
} from "./policy-values.js";
import { validateTrustedProviderSelection } from "./provider-trust.js";

const DEFAULT_PROFILE_PATH = join(
  POLICY_PROJECT_ROOT,
  "profiles",
  "default.yaml",
);

export interface ResolvedPolicyLayers {
  readonly merged: PolicyLayer;
  readonly selectedProfile: ProfileDocument;
  readonly origins: ReadonlyMap<string, string>;
  readonly repositoryProfileSource?: string;
}

export interface PolicyLayerResolution {
  readonly value?: ResolvedPolicyLayers;
  readonly sources: readonly PolicySource[];
}

function profilePath(
  repository: string,
  profileName: string | undefined,
): string {
  if (profileName === undefined) {
    return join(repository, ".code-quality", "profile.yaml");
  }
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(profileName)) {
    throw new StructuredConfigError(
      "PROFILE_NAME_INVALID",
      "invocation",
      "Profile name must be a bounded lowercase identifier",
      "/profileName",
    );
  }
  return join(repository, ".code-quality", "profiles", `${profileName}.yaml`);
}

function profileSource(repository: string, path: string): string {
  return relative(repository, path).replaceAll("\\", "/");
}

async function loadRepositoryProfile(
  request: ResolvePolicyRequest,
  budget: StructuredReadBudget,
): Promise<{
  readonly document?: ProfileDocument;
  readonly diagnostics: readonly PolicyDiagnostic[];
  readonly source?: PolicySource;
}> {
  let path: string;
  try {
    path = profilePath(request.repository, request.profileName);
  } catch (error) {
    if (error instanceof StructuredConfigError) {
      return { diagnostics: [configDiagnostic(error)] };
    }
    throw error;
  }
  const source = profileSource(request.repository, path);
  const loaded = await loadPolicyDocument<ProfileDocument>(
    "profile",
    path,
    source,
    request.repository,
    budget,
  );
  const missingOptionalProfile =
    request.profileName === undefined &&
    loaded.diagnostics.length === 1 &&
    loaded.diagnostics[0]?.code === "CONFIG_NOT_FOUND";
  if (missingOptionalProfile) {
    return { diagnostics: [] };
  }
  if (loaded.value === undefined) {
    return {
      diagnostics:
        loaded.diagnostics.length > 0
          ? loaded.diagnostics
          : [
              {
                code: "PROFILE_INVALID",
                source,
                path: "",
                message: "Repository profile could not be validated",
              },
            ],
      ...(loaded.structuredSource === undefined
        ? {}
        : {
            source: filePolicySource(
              "repository-profile",
              loaded.structuredSource,
              4,
            ),
          }),
    };
  }
  return {
    document: loaded.value,
    diagnostics: [],
    ...(loaded.structuredSource === undefined
      ? {}
      : {
          source: filePolicySource(
            "repository-profile",
            loaded.structuredSource,
            4,
          ),
        }),
  };
}

export async function resolvePolicyLayers(
  request: ResolvePolicyRequest,
  budget: StructuredReadBudget,
  diagnostics: PolicyDiagnosticCollector,
): Promise<PolicyLayerResolution> {
  const sources: PolicySource[] = [];
  const builtIn = await loadPolicyDocument<ProfileDocument>(
    "profile",
    DEFAULT_PROFILE_PATH,
    "profiles/default.yaml",
    POLICY_PROJECT_ROOT,
    budget,
  );
  diagnostics.add(builtIn.diagnostics);
  if (builtIn.structuredSource !== undefined) {
    sources.push(
      filePolicySource("built-in-defaults", builtIn.structuredSource, 1),
    );
  }
  if (builtIn.value === undefined) {
    return { sources };
  }

  const origins = new Map<string, string>();
  let merged: PolicyLayer = mergePolicyLayer(
    {},
    builtIn.value,
    "built-in-defaults",
    origins,
  );
  let selectedProfile = builtIn.value;
  if (request.userDefaults !== undefined) {
    const issues = validatePolicyLayer(request.userDefaults, "user-defaults");
    diagnostics.add(issues);
    sources.push(
      inlinePolicySource(
        "user-defaults",
        "user-defaults",
        request.userDefaults,
        2,
      ),
    );
    if (issues.length === 0) {
      merged = mergePolicyLayer(
        merged,
        request.userDefaults,
        "user-defaults",
        origins,
      );
    }
  }

  const repositoryProfile = await loadRepositoryProfile(request, budget);
  diagnostics.add(repositoryProfile.diagnostics);
  if (repositoryProfile.source !== undefined) {
    sources.push(repositoryProfile.source);
  }
  if (repositoryProfile.document !== undefined) {
    selectedProfile = repositoryProfile.document;
    merged = mergePolicyLayer(
      merged,
      repositoryProfile.document,
      "repository-profile",
      origins,
    );
  }
  if (request.overrides !== undefined) {
    const issues = validatePolicyLayer(request.overrides, "invocation");
    diagnostics.add(issues);
    sources.push(
      inlinePolicySource("invocation", "invocation", request.overrides, 5),
    );
    if (issues.length === 0) {
      merged = mergePolicyLayer(
        merged,
        request.overrides,
        "invocation",
        origins,
      );
    }
  }
  if (diagnostics.hasDiagnostics) {
    return { sources };
  }

  merged = applySafetyInvariants(merged, origins);
  const providerDiagnostics = validateTrustedProviderSelection(
    merged.provider,
    request.trustedProviders,
  );
  diagnostics.add(providerDiagnostics);
  if (providerDiagnostics.length > 0) {
    return { sources };
  }
  sources.push(
    inlinePolicySource(
      "safety-invariants",
      "safety-invariants",
      {
        maxProviderConcurrency: 2,
        maxProviderAttempts: 16,
        maxStructuredFileBytes: 1024 * 1024,
        maxResolutionBytes: 8 * 1024 * 1024,
      },
      6,
    ),
  );
  return {
    sources,
    value: {
      merged,
      selectedProfile,
      origins,
      ...(repositoryProfile.source === undefined
        ? {}
        : { repositoryProfileSource: repositoryProfile.source.source }),
    },
  };
}
