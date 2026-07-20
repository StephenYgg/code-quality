export type PolicyDocumentKind =
  "finding" | "profile" | "rule" | "run" | "score-model" | "waiver";

export type Severity = "NIT" | "P0" | "P1" | "P2" | "P3";
export type GateMode = "advisory" | "block" | "hard_block" | "warn";

export interface PolicyDiagnostic {
  readonly code: string;
  readonly source: string;
  readonly path: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export interface RuleDefinition {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly rationale: string;
  readonly scope:
    | "compatibility"
    | "concurrency"
    | "readability"
    | "repository"
    | "security"
    | "testing"
    | "universal";
  readonly triggers: readonly string[];
  readonly defaultSeverity: Severity;
  readonly gateMode: GateMode;
  readonly detection: "deterministic" | "hybrid" | "semantic";
  readonly requiredEvidence: readonly string[];
  readonly remediation: string;
  readonly verification: string;
  readonly owner: string;
  readonly examples: readonly {
    readonly kind: "negative" | "positive";
    readonly description: string;
  }[];
  readonly lifecycle: "active" | "deprecated" | "experimental";
}

export interface RulePackDocument {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly version: number;
  readonly rules: readonly RuleDefinition[];
}

export interface PolicyBudgets {
  readonly maxFiles?: number;
  readonly maxChangedLines?: number;
  readonly maxDiffBytes?: number;
  readonly maxStages?: number;
  readonly maxProviderConcurrency?: number;
  readonly maxProviderAttempts?: number;
  readonly maxTokens?: number;
  readonly timeoutSeconds?: number;
  readonly maxCostUsd?: number;
}

export interface ProviderSelection {
  readonly name: string;
  readonly modelPolicy?: string;
  readonly model?: string;
}

export interface TrustedProviderDefinition {
  readonly name: string;
  readonly allowedModelPolicies: readonly string[];
  readonly allowedModels: readonly string[];
}

export interface ScoreModelSelection {
  readonly id?: string;
  readonly majorWeights?: Readonly<Record<string, number>>;
  readonly minorWeights?: Readonly<Record<string, number>>;
}

export interface PolicyQualityCommand {
  readonly label: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

export interface RuleOverride {
  readonly enabled?: boolean;
  readonly severity?: Severity;
  readonly gateMode?: GateMode;
}

export interface PolicyLayer {
  readonly rulePacks?: readonly string[];
  readonly provider?: ProviderSelection;
  readonly dataClassification?:
    "confidential" | "internal" | "public" | "restricted";
  readonly budgets?: PolicyBudgets;
  readonly gate?: {
    readonly mode?: "advisory" | "block" | "warn";
    readonly blockSeverity?: "P0" | "P1" | "P2";
    readonly minimumConfidence?: "deterministic" | "high" | "low" | "medium";
  };
  readonly ruleOverrides?: Readonly<Record<string, RuleOverride>>;
  readonly waiverLocations?: readonly string[];
  readonly scoreModel?: ScoreModelSelection;
  readonly criticalPaths?: readonly string[];
  readonly riskTriggers?: readonly string[];
  readonly qualityCommands?: readonly PolicyQualityCommand[];
  readonly peerAgentDocuments?: readonly string[];
}

export interface ProfileDocument extends PolicyLayer {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly version: number;
  readonly rulePacks: readonly string[];
  readonly repository?: {
    readonly identity?: string;
    readonly technologyTags?: readonly string[];
  };
}

export interface PolicySource {
  readonly kind:
    | "built-in-defaults"
    | "invocation"
    | "repository-profile"
    | "rule-pack"
    | "safety-invariants"
    | "user-defaults"
    | "waiver";
  readonly source: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly precedence: number;
}

export interface PolicyResolutionEntry {
  readonly path: string;
  readonly source: string;
}

export interface EffectivePolicy extends PolicyLayer {
  readonly schemaVersion: "1";
  readonly profile: {
    readonly id: string;
    readonly version: number;
  };
  readonly rulePacks: readonly string[];
  readonly rules: readonly RuleDefinition[];
  readonly budgets: PolicyBudgets;
  readonly resolution: readonly PolicyResolutionEntry[];
  readonly waivers: readonly Waiver[];
}

export interface ResolvePolicyRequest {
  readonly repository: string;
  readonly profileName?: string;
  readonly now?: Date;
  readonly overrides?: PolicyLayer;
  readonly userDefaults?: PolicyLayer;
  readonly trustedProviders?: readonly TrustedProviderDefinition[];
}

export interface EffectivePolicyResult {
  readonly policy?: EffectivePolicy;
  readonly policyHash?: string;
  readonly diagnostics: readonly PolicyDiagnostic[];
  readonly sources: readonly PolicySource[];
  readonly waivers: readonly Waiver[];
}
import type { Waiver } from "./waivers.js";
