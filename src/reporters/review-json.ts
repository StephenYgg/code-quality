import type { ReviewRunResult } from "../review/orchestrator.js";
import type { StoredRunRecord } from "../storage/runs.js";

export function renderReviewJson(
  result: ReviewRunResult | StoredRunRecord,
): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
