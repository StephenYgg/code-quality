import {
  inferRiskSignals,
  MANDATORY_STAGES,
  routeStages,
  type ReviewStageId,
  type RiskSignals,
} from "../core/risk-router.js";
import type { ReviewSnapshot } from "../core/snapshots.js";

export type ReviewExecutionPreset = "fast" | "full";

export interface ReviewPlan {
  readonly stages: readonly ReviewStageId[];
  readonly signals: RiskSignals;
  readonly maxInFlight: number;
  readonly maxAttempts: number;
  readonly execution: ReviewExecutionPreset;
}

interface ResolvedPlanOptions {
  readonly execution: ReviewExecutionPreset;
  readonly signalOverrides: RiskSignals;
  readonly maxStages: number;
  readonly maxInFlight: number;
  readonly maxAttempts: number;
  readonly maximumStages: number;
  readonly maximumInFlight: number;
  readonly maximumAttempts: number;
  readonly minimumStages: number;
}

function resolvePlanOptions(
  options: Parameters<typeof planReview>[1],
): ResolvedPlanOptions {
  const execution = options?.execution ?? "full";
  const fast = execution === "fast";
  const maximumStages = fast ? 1 : 7;
  const maximumInFlight = fast ? 1 : 2;
  const maximumAttempts = fast ? 2 : 16;
  return {
    execution,
    signalOverrides: options?.signalOverrides ?? {},
    maxStages: options?.maxStages ?? maximumStages,
    maxInFlight: options?.maxInFlight ?? maximumInFlight,
    maxAttempts: options?.maxAttempts ?? maximumAttempts,
    maximumStages,
    maximumInFlight,
    maximumAttempts,
    minimumStages: fast ? 1 : MANDATORY_STAGES.length,
  };
}

function assertPlanBudget(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside its effective limit`);
  }
}

function selectedStages(
  execution: ReviewExecutionPreset,
  signals: RiskSignals,
  maxStages: number,
): readonly ReviewStageId[] {
  if (execution === "fast") return Object.freeze(["universal"] as const);
  const stages = Object.freeze(routeStages(signals).slice(0, maxStages));
  for (const mandatory of MANDATORY_STAGES) {
    if (!stages.includes(mandatory)) {
      throw new Error(`Mandatory stage missing from plan: ${mandatory}`);
    }
  }
  return stages;
}

export function planReview(
  snapshot: ReviewSnapshot,
  options?: {
    readonly signalOverrides?: RiskSignals;
    readonly execution?: ReviewExecutionPreset;
    readonly maxStages?: number;
    readonly maxInFlight?: number;
    readonly maxAttempts?: number;
  },
): ReviewPlan {
  const resolved = resolvePlanOptions(options);
  assertPlanBudget(
    resolved.maxStages,
    resolved.minimumStages,
    resolved.maximumStages,
    "Review stage budget",
  );
  assertPlanBudget(
    resolved.maxInFlight,
    1,
    resolved.maximumInFlight,
    "Review concurrency budget",
  );
  assertPlanBudget(
    resolved.maxAttempts,
    1,
    resolved.maximumAttempts,
    "Review attempt budget",
  );
  const paths = snapshot.files.map((file) => file.path);
  const signals = {
    ...inferRiskSignals(paths),
    ...resolved.signalOverrides,
  };
  const stages = selectedStages(
    resolved.execution,
    signals,
    resolved.maxStages,
  );
  return Object.freeze({
    stages,
    signals: Object.freeze({ ...signals }),
    maxInFlight: resolved.maxInFlight,
    maxAttempts: resolved.maxAttempts,
    execution: resolved.execution,
  });
}
