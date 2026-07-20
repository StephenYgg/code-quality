import { createHash } from "node:crypto";

import type { DataClassification, EgressClass } from "../core/egress.js";
import { canonicalizePolicy, deepFreezePolicy } from "../core/policy-values.js";
import type { Severity } from "../core/policy-types.js";
import type { ProviderKind } from "../providers/provider.js";

export const EXECUTION_DESCRIPTOR_VERSION = "1" as const;

interface DescriptorLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly maxIndividualFileBytes: number;
}

interface ContextLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxSnapshotFiles: number;
  readonly maxSnapshotExclusions: number;
  readonly maxSnapshotPathBytes: number;
}

export interface ExecutionDescriptorInput {
  readonly policy: { readonly hash: string };
  readonly provider: {
    readonly name: string;
    readonly kind: ProviderKind;
    readonly providerClass: string;
    readonly trustedConfigIdentity: string;
  };
  readonly model: string;
  readonly endpoint: { readonly identity: string; readonly class: string };
  readonly egress: { readonly policy: string; readonly class: EgressClass };
  readonly dataClassification: DataClassification;
  readonly repository: {
    readonly selector: "full_repository";
    readonly limits: DescriptorLimits;
  };
  readonly context: ContextLimits;
  readonly budgets: {
    readonly maxChangedFiles: number;
    readonly maxChangedLines: number;
    readonly maxDiffBytes: number;
    readonly maxTokens: number;
    readonly maxOutputTokens: number;
    readonly maxDurationMs: number;
    readonly maxCostUsd: number;
    readonly maxAttempts: number;
    readonly maxInFlight: number;
    readonly maxStages: number;
  };
  readonly score: {
    readonly enabled: boolean;
    readonly mode: "review" | "score";
    readonly modelFingerprint: string;
    readonly modelVersion: string;
  };
  readonly verification: {
    readonly required: boolean;
    readonly runChecks: {
      readonly enabled: boolean;
      readonly previewOnly: boolean;
      readonly commandsHash: string | null;
    };
  };
  readonly gate: {
    readonly mode: "advisory" | "block" | "warn";
    readonly blockSeverity: Extract<Severity, "P0" | "P1" | "P2">;
    readonly minimumConfidence: "deterministic" | "high" | "low" | "medium";
  };
}

export interface ExecutionDescriptor extends ExecutionDescriptorInput {
  readonly schemaVersion: typeof EXECUTION_DESCRIPTOR_VERSION;
}

export class ExecutionDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionDescriptorError";
  }
}

function assertHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value) || value === "0".repeat(64)) {
    throw new ExecutionDescriptorError(
      `${label} must be a non-zero SHA-256 hash`,
    );
  }
}

function assertText(value: string, label: string): void {
  if (value.length < 1 || value.length > 512 || value.includes("\0")) {
    throw new ExecutionDescriptorError(`${label} is invalid`);
  }
}

function assertEnum(
  value: string,
  allowed: readonly string[],
  label: string,
): void {
  if (!allowed.includes(value)) {
    throw new ExecutionDescriptorError(`${label} is unsupported`);
  }
}

function assertInteger(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ExecutionDescriptorError(`${label} is outside its hard limit`);
  }
}

function validateLimits(input: ExecutionDescriptorInput): void {
  const limits = input.repository.limits;
  assertInteger(limits.maxFiles, "maxFiles", 5_000);
  assertInteger(limits.maxBytes, "maxBytes", 50 * 1024 * 1024);
  assertInteger(limits.maxEntries, "maxEntries", 20_000);
  assertInteger(
    limits.maxIndividualFileBytes,
    "maxIndividualFileBytes",
    1024 * 1024,
  );
  for (const [label, value, maximum] of [
    ["context.maxFiles", input.context.maxFiles, 200],
    ["context.maxFileBytes", input.context.maxFileBytes, 1024 * 1024],
    ["context.maxTotalBytes", input.context.maxTotalBytes, 8 * 1024 * 1024],
    ["context.maxSnapshotFiles", input.context.maxSnapshotFiles, 5_000],
    [
      "context.maxSnapshotExclusions",
      input.context.maxSnapshotExclusions,
      5_000,
    ],
    [
      "context.maxSnapshotPathBytes",
      input.context.maxSnapshotPathBytes,
      16_384,
    ],
  ] as const) {
    assertInteger(value, label, maximum);
  }
}

function validateBudgets(input: ExecutionDescriptorInput): void {
  const budgets = input.budgets;
  for (const [label, value, maximum] of [
    ["maxChangedFiles", budgets.maxChangedFiles, 10_000],
    ["maxChangedLines", budgets.maxChangedLines, 1_000_000],
    ["maxDiffBytes", budgets.maxDiffBytes, 64 * 1024 * 1024],
    ["maxTokens", budgets.maxTokens, 10_000_000],
    ["maxOutputTokens", budgets.maxOutputTokens, 100_000],
    ["maxDurationMs", budgets.maxDurationMs, 24 * 60 * 60 * 1_000],
    ["maxAttempts", budgets.maxAttempts, 64],
    ["maxInFlight", budgets.maxInFlight, 16],
    ["maxStages", budgets.maxStages, 32],
  ] as const) {
    assertInteger(value, label, maximum);
  }
  if (budgets.maxAttempts < budgets.maxStages) {
    throw new ExecutionDescriptorError(
      "maxAttempts cannot cover the configured review stages",
    );
  }
  if (budgets.maxOutputTokens > budgets.maxTokens) {
    throw new ExecutionDescriptorError(
      "maxOutputTokens cannot exceed the total token budget",
    );
  }
  if (
    !Number.isFinite(budgets.maxCostUsd) ||
    budgets.maxCostUsd < 0 ||
    budgets.maxCostUsd > 1_000_000
  ) {
    throw new ExecutionDescriptorError("maxCostUsd is outside its hard limit");
  }
}

function validateDescriptor(input: ExecutionDescriptorInput): void {
  assertHash(input.policy.hash, "policy hash");
  assertText(input.provider.name, "provider name");
  assertEnum(
    input.provider.kind,
    ["codex_cli", "claude_cli", "openai_compatible", "anthropic_compatible"],
    "provider kind",
  );
  assertText(input.provider.providerClass, "provider class");
  assertHash(input.provider.trustedConfigIdentity, "trusted config identity");
  assertText(input.model, "model");
  assertHash(input.endpoint.identity, "endpoint identity");
  assertText(input.endpoint.class, "endpoint class");
  assertText(input.egress.policy, "egress policy");
  assertEnum(
    input.egress.class,
    ["local", "loopback", "https"],
    "egress class",
  );
  assertEnum(
    input.dataClassification,
    ["public", "internal", "confidential", "restricted"],
    "data classification",
  );
  assertEnum(
    input.repository.selector,
    ["full_repository"],
    "repository selector",
  );
  assertHash(input.score.modelFingerprint, "score model fingerprint");
  assertText(input.score.modelVersion, "score model version");
  assertEnum(input.score.mode, ["review", "score"], "score mode");
  assertEnum(input.gate.mode, ["advisory", "block", "warn"], "gate mode");
  assertEnum(input.gate.blockSeverity, ["P0", "P1", "P2"], "gate severity");
  assertEnum(
    input.gate.minimumConfidence,
    ["deterministic", "high", "medium", "low"],
    "gate confidence",
  );
  if (input.score.enabled !== (input.score.mode === "score")) {
    throw new ExecutionDescriptorError("score enabled and mode disagree");
  }
  if (
    input.verification.runChecks.previewOnly &&
    !input.verification.runChecks.enabled
  ) {
    throw new ExecutionDescriptorError(
      "run-checks preview requires run-checks",
    );
  }
  if (input.verification.runChecks.enabled) {
    if (input.verification.runChecks.commandsHash === null) {
      throw new ExecutionDescriptorError(
        "run-checks commands hash is required",
      );
    }
    assertHash(
      input.verification.runChecks.commandsHash,
      "run-checks commands hash",
    );
  } else if (input.verification.runChecks.commandsHash !== null) {
    throw new ExecutionDescriptorError(
      "disabled run-checks cannot bind commands",
    );
  }
  validateLimits(input);
  validateBudgets(input);
}

export function createExecutionDescriptor(
  input: ExecutionDescriptorInput,
): ExecutionDescriptor {
  validateDescriptor(input);
  return deepFreezePolicy({
    schemaVersion: EXECUTION_DESCRIPTOR_VERSION,
    ...structuredClone(input),
  });
}

export function serializeExecutionDescriptor(
  descriptor: ExecutionDescriptor,
): string {
  validateDescriptor(descriptor);
  const schemaVersion: unknown = descriptor.schemaVersion;
  if (schemaVersion !== EXECUTION_DESCRIPTOR_VERSION) {
    throw new ExecutionDescriptorError(
      "execution descriptor version is unsupported",
    );
  }
  return canonicalizePolicy(descriptor);
}

export function executionDescriptorHash(
  descriptor: ExecutionDescriptor,
): string {
  return createHash("sha256")
    .update("cq-execution-descriptor/v1\0")
    .update(serializeExecutionDescriptor(descriptor), "utf8")
    .digest("hex");
}
