import { resolveEffectivePolicy } from "../core/policy.js";
import type { DataClassification } from "../core/egress.js";
import type {
  PolicyBudgets,
  PolicyQualityCommand,
} from "../core/policy-types.js";
import type { ScoreModel } from "../core/scoring.js";
import {
  loadUserConfig,
  userConfigToTrustedCatalog,
} from "../core/user-config.js";
import { materializeProfileScoreModel } from "./profile-score-model.js";

export interface BoundReviewPolicy {
  readonly policyHash: string;
  readonly dataClassification: DataClassification;
  readonly providerName?: string;
  readonly model?: string;
  readonly diagnostics: readonly string[];
  readonly scoreModel: ScoreModel;
  readonly budgets: Required<PolicyBudgets>;
  readonly gate: {
    readonly mode: "advisory" | "block" | "warn";
    readonly blockSeverity: "P0" | "P1" | "P2";
    readonly minimumConfidence: "deterministic" | "high" | "low" | "medium";
  };
  readonly qualityCommands: readonly PolicyQualityCommand[];
}

export class PolicyBindingError extends Error {
  constructor(readonly diagnostics: readonly string[]) {
    super(diagnostics[0] ?? "Effective review policy is invalid");
    this.name = "PolicyBindingError";
  }
}

function requiredBudget<K extends keyof PolicyBudgets>(
  budgets: PolicyBudgets,
  key: K,
): NonNullable<PolicyBudgets[K]> {
  const value = budgets[key];
  if (value === undefined) {
    throw new PolicyBindingError([`Effective policy budget ${key} is missing`]);
  }
  return value;
}

function completeBudgets(budgets: PolicyBudgets): Required<PolicyBudgets> {
  return {
    maxFiles: requiredBudget(budgets, "maxFiles"),
    maxChangedLines: requiredBudget(budgets, "maxChangedLines"),
    maxDiffBytes: requiredBudget(budgets, "maxDiffBytes"),
    maxStages: requiredBudget(budgets, "maxStages"),
    maxProviderConcurrency: requiredBudget(budgets, "maxProviderConcurrency"),
    maxProviderAttempts: requiredBudget(budgets, "maxProviderAttempts"),
    maxTokens: requiredBudget(budgets, "maxTokens"),
    timeoutSeconds: requiredBudget(budgets, "timeoutSeconds"),
    maxCostUsd: requiredBudget(budgets, "maxCostUsd"),
  };
}

/**
 * Binds review execution to effective policy resolved outside untrusted head
 * content. Provider credentials still come only from trusted user config.
 */
export async function bindReviewPolicy(options: {
  readonly repository: string;
  readonly configPath?: string;
  readonly profileName?: string;
}): Promise<BoundReviewPolicy> {
  let configFailure: string | undefined;
  let trustedProviders;
  try {
    const userConfig = await loadUserConfig({
      ...(options.configPath === undefined ? {} : { path: options.configPath }),
    });
    trustedProviders = userConfigToTrustedCatalog(userConfig);
  } catch (error) {
    configFailure =
      error instanceof Error
        ? error.message
        : "Trusted user config unavailable for policy binding";
  }

  const resolved = await resolveEffectivePolicy({
    repository: options.repository,
    ...(options.profileName === undefined
      ? {}
      : { profileName: options.profileName }),
    ...(trustedProviders === undefined ? {} : { trustedProviders }),
  });

  if (resolved.policy === undefined || resolved.policyHash === undefined) {
    throw new PolicyBindingError([
      ...(configFailure === undefined ? [] : [configFailure]),
      ...resolved.diagnostics.map((item) => `${item.code}: ${item.message}`),
    ]);
  }

  const classification = resolved.policy.dataClassification ?? "internal";
  const scoreModel = materializeProfileScoreModel(
    resolved.policy.scoreModel,
    resolved.policyHash,
  );
  const gate = resolved.policy.gate;
  if (
    gate?.mode === undefined ||
    gate.blockSeverity === undefined ||
    gate.minimumConfidence === undefined
  ) {
    throw new PolicyBindingError(["Effective policy gate is incomplete"]);
  }
  return {
    policyHash: resolved.policyHash,
    dataClassification: classification,
    ...(resolved.policy.provider?.name === undefined
      ? {}
      : { providerName: resolved.policy.provider.name }),
    ...(resolved.policy.provider?.model === undefined
      ? {}
      : { model: resolved.policy.provider.model }),
    diagnostics: Object.freeze([]),
    scoreModel,
    budgets: completeBudgets(resolved.policy.budgets),
    gate: {
      mode: gate.mode,
      blockSeverity: gate.blockSeverity,
      minimumConfidence: gate.minimumConfidence,
    },
    qualityCommands: Object.freeze(
      (resolved.policy.qualityCommands ?? []).map((command) =>
        Object.freeze({ ...command, argv: Object.freeze([...command.argv]) }),
      ),
    ),
  };
}
