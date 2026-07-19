import {
  inferRiskSignals,
  MANDATORY_STAGES,
  routeStages,
  type ReviewStageId,
  type RiskSignals,
} from "../core/risk-router.js";
import type { ReviewSnapshot } from "../core/snapshots.js";

export interface ReviewPlan {
  readonly stages: readonly ReviewStageId[];
  readonly signals: RiskSignals;
  readonly maxInFlight: 2;
  readonly maxAttempts: 16;
}

export function planReview(
  snapshot: ReviewSnapshot,
  signalOverrides?: RiskSignals,
): ReviewPlan {
  const paths = snapshot.files.map((file) => file.path);
  const signals = {
    ...inferRiskSignals(paths),
    ...signalOverrides,
  };
  const stages = routeStages(signals);
  for (const mandatory of MANDATORY_STAGES) {
    if (!stages.includes(mandatory)) {
      throw new Error(`Mandatory stage missing from plan: ${mandatory}`);
    }
  }
  return Object.freeze({
    stages,
    signals: Object.freeze({ ...signals }),
    maxInFlight: 2,
    maxAttempts: 16,
  });
}
