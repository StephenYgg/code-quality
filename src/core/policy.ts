import { join } from "node:path";

import {
  createStructuredReadBudget,
  type StructuredReadBudget,
} from "./config.js";
import { compareCodeUnits } from "./deterministic-order.js";
import { PolicyDiagnosticCollector } from "./policy-diagnostics.js";
import { resolvePolicyLayers } from "./policy-layers.js";
import {
  POLICY_PROJECT_ROOT,
  loadPolicyDocument,
  type LoadedDocument,
  validatePolicyDocument,
} from "./policy-schema.js";
import type {
  EffectivePolicy,
  EffectivePolicyResult,
  PolicyDiagnostic,
  PolicyLayer,
  PolicySource,
  ProfileDocument,
  ResolvePolicyRequest,
  RuleDefinition,
  RulePackDocument,
} from "./policy-types.js";
import {
  canonicalizePolicy,
  deepFreezePolicy,
  filePolicySource,
  policySha256,
} from "./policy-values.js";
import { discoverWaivers, type WaiverDiscoveryIo } from "./waiver-discovery.js";
import type { Waiver } from "./waivers.js";

export { validatePolicyDocument };
export type {
  EffectivePolicy,
  EffectivePolicyResult,
  GateMode,
  PolicyBudgets,
  PolicyDiagnostic,
  PolicyDocumentKind,
  PolicyLayer,
  PolicyResolutionEntry,
  PolicySource,
  ProviderSelection,
  ResolvePolicyRequest,
  RuleDefinition,
  RuleOverride,
  ScoreModelSelection,
  Severity,
  TrustedProviderDefinition,
} from "./policy-types.js";

const BUILTIN_RULES_DIRECTORY = join(POLICY_PROJECT_ROOT, "rules", "builtin");

export interface ResolvePolicyOptions {
  readonly trustedRulePackLoader?: TrustedRulePackLoader;
  readonly trustedWaiverDiscoveryIo?: WaiverDiscoveryIo;
}

export interface RulePackLoadRequest {
  readonly budget: StructuredReadBudget;
  readonly containmentRoot: string;
  readonly path: string;
  readonly source: string;
}

export type TrustedRulePackLoader = (
  request: RulePackLoadRequest,
) => Promise<LoadedDocument<RulePackDocument>>;

function defaultRulePackLoader(
  request: RulePackLoadRequest,
): Promise<LoadedDocument<RulePackDocument>> {
  return loadPolicyDocument<RulePackDocument>(
    "rule",
    request.path,
    request.source,
    request.containmentRoot,
    request.budget,
  );
}

function repositoryRulePackPath(
  repository: string,
  reference: string,
): {
  readonly path: string;
  readonly source: string;
  readonly containmentRoot: string;
} {
  const [kind, name] = reference.split(":");
  if (kind === "builtin") {
    return {
      path: join(BUILTIN_RULES_DIRECTORY, `${name ?? ""}.yaml`),
      source: `rules/builtin/${name ?? ""}.yaml`,
      containmentRoot: POLICY_PROJECT_ROOT,
    };
  }
  return {
    path: join(repository, ".code-quality", "rules", `${name ?? ""}.yaml`),
    source: `.code-quality/rules/${name ?? ""}.yaml`,
    containmentRoot: repository,
  };
}

async function loadRulePacks(
  references: readonly string[],
  repository: string,
  budget: StructuredReadBudget,
  diagnostics: PolicyDiagnosticCollector,
  loadRulePack: TrustedRulePackLoader,
): Promise<{
  readonly rules: readonly RuleDefinition[];
  readonly sources: readonly PolicySource[];
}> {
  const sources: PolicySource[] = [];
  const rules: RuleDefinition[] = [];
  const ownerByRule = new Map<string, string>();
  for (const reference of references) {
    if (diagnostics.exhausted) {
      break;
    }
    const location = repositoryRulePackPath(repository, reference);
    const loaded = await loadRulePack({
      budget,
      containmentRoot: location.containmentRoot,
      path: location.path,
      source: location.source,
    });
    if (loaded.diagnostics.length > 0 || loaded.value === undefined) {
      diagnostics.add(
        loaded.diagnostics.map((diagnostic) =>
          diagnostic.code === "CONFIG_NOT_FOUND"
            ? { ...diagnostic, code: "RULE_PACK_NOT_FOUND" }
            : diagnostic,
        ),
      );
      continue;
    }
    if (loaded.structuredSource !== undefined) {
      sources.push(filePolicySource("rule-pack", loaded.structuredSource, 3));
    }
    for (const rule of loaded.value.rules) {
      const existing = ownerByRule.get(rule.id);
      if (existing !== undefined) {
        const hasCapacity = diagnostics.add([
          {
            code: "DUPLICATE_RULE_ID",
            source: location.source,
            path: `/rules/${rule.id}`,
            message: `Rule ${rule.id} is already defined by ${existing}`,
          },
        ]);
        if (!hasCapacity) {
          break;
        }
        continue;
      }
      ownerByRule.set(rule.id, location.source);
      rules.push(rule);
    }
  }
  return {
    rules: rules.sort(
      (left, right) =>
        compareCodeUnits(left.id, right.id) || left.version - right.version,
    ),
    sources,
  };
}

function sortPolicySources(sources: readonly PolicySource[]): PolicySource[] {
  return [...sources].sort(
    (left, right) =>
      left.precedence - right.precedence ||
      compareCodeUnits(left.source, right.source),
  );
}

function invalidResult(
  diagnostics: PolicyDiagnosticCollector,
  sources: readonly PolicySource[],
  waivers: readonly Waiver[] = [],
): EffectivePolicyResult {
  return deepFreezePolicy({
    diagnostics: diagnostics.toArray(),
    sources: sortPolicySources(sources),
    waivers: [...waivers],
  });
}

function validateRuleOverrideReferences(
  policy: PolicyLayer,
  rules: readonly RuleDefinition[],
  origins: ReadonlyMap<string, string>,
  repositoryProfileSource: string | undefined,
): readonly PolicyDiagnostic[] {
  const selectedRuleIds = new Set(rules.map((rule) => rule.id));
  return Object.keys(policy.ruleOverrides ?? {})
    .filter((ruleId) => !selectedRuleIds.has(ruleId))
    .map((ruleId) => {
      const path = `/ruleOverrides/${ruleId}`;
      const origin = origins.get(path) ?? "effective-policy";
      return {
        code: "RULE_OVERRIDE_NOT_FOUND",
        source:
          origin === "repository-profile" &&
          repositoryProfileSource !== undefined
            ? repositoryProfileSource
            : origin,
        path,
        message: `Rule override ${ruleId} does not reference a selected rule`,
      };
    });
}

function buildEffectivePolicy(
  selectedProfile: ProfileDocument,
  merged: PolicyLayer,
  rules: readonly RuleDefinition[],
  waivers: readonly Waiver[],
  origins: ReadonlyMap<string, string>,
): EffectivePolicy {
  const rulePacks = merged.rulePacks ?? [];
  const resolution = [...origins.entries()]
    .map(([path, source]) => ({ path, source }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  return {
    schemaVersion: "1",
    profile: { id: selectedProfile.id, version: selectedProfile.version },
    rulePacks: [...rulePacks],
    rules: [...rules],
    budgets: { ...merged.budgets },
    waivers: [...waivers],
    resolution,
    ...(merged.provider === undefined
      ? {}
      : { provider: { ...merged.provider } }),
    ...(merged.dataClassification === undefined
      ? {}
      : { dataClassification: merged.dataClassification }),
    ...(merged.gate === undefined ? {} : { gate: { ...merged.gate } }),
    ...(merged.ruleOverrides === undefined
      ? {}
      : { ruleOverrides: { ...merged.ruleOverrides } }),
    ...(merged.waiverLocations === undefined
      ? {}
      : { waiverLocations: [...merged.waiverLocations] }),
    ...(merged.scoreModel === undefined
      ? {}
      : { scoreModel: { ...merged.scoreModel } }),
    ...(merged.criticalPaths === undefined
      ? {}
      : { criticalPaths: [...merged.criticalPaths] }),
    ...(merged.riskTriggers === undefined
      ? {}
      : { riskTriggers: [...merged.riskTriggers] }),
    ...(merged.qualityCommands === undefined
      ? {}
      : {
          qualityCommands: merged.qualityCommands.map((command) => ({
            ...command,
            argv: [...command.argv],
          })),
        }),
    ...(merged.peerAgentDocuments === undefined
      ? {}
      : { peerAgentDocuments: [...merged.peerAgentDocuments] }),
  };
}

export async function resolveEffectivePolicy(
  request: ResolvePolicyRequest,
  options: ResolvePolicyOptions = {},
): Promise<EffectivePolicyResult> {
  const diagnostics = new PolicyDiagnosticCollector();
  const budget = createStructuredReadBudget();
  const layerResolution = await resolvePolicyLayers(
    request,
    budget,
    diagnostics,
  );
  if (layerResolution.value === undefined) {
    return invalidResult(diagnostics, layerResolution.sources);
  }
  const layers = layerResolution.value;
  const sources = [...layerResolution.sources];
  const rulePacks = layers.merged.rulePacks ?? [];
  const loadedRules = await loadRulePacks(
    rulePacks,
    request.repository,
    budget,
    diagnostics,
    options.trustedRulePackLoader ?? defaultRulePackLoader,
  );
  sources.push(...loadedRules.sources);
  if (!diagnostics.exhausted) {
    diagnostics.add(
      validateRuleOverrideReferences(
        layers.merged,
        loadedRules.rules,
        layers.origins,
        layers.repositoryProfileSource,
      ),
    );
  }
  if (diagnostics.hasDiagnostics) {
    return invalidResult(diagnostics, sources);
  }

  const discoveredWaivers = await discoverWaivers(
    request.repository,
    layers.merged.waiverLocations ?? [],
    budget,
    request.now ?? new Date(),
    options.trustedWaiverDiscoveryIo,
    diagnostics,
  );
  sources.push(...discoveredWaivers.sources);
  if (discoveredWaivers.diagnostics.length > 0) {
    return invalidResult(diagnostics, sources);
  }

  const policy = deepFreezePolicy(
    buildEffectivePolicy(
      layers.selectedProfile,
      layers.merged,
      loadedRules.rules,
      discoveredWaivers.waivers,
      layers.origins,
    ),
  );
  return deepFreezePolicy({
    policy,
    policyHash: policySha256(canonicalizePolicy(policy)),
    diagnostics: [],
    waivers: policy.waivers,
    sources: sortPolicySources(sources),
  });
}
