export function exportResult(stage: string, value: unknown): object {
  if (stage === "collect") {
    return { ok: true, stage, value, collectedAt: Date.now(), warnings: [] };
  }
  if (stage === "transform") {
    return { ok: true, stage, value, transformations: [], elapsedMs: 0 };
  }
  if (stage === "write") {
    return { ok: true, stage, location: String(value), bytes: 0, retries: 0 };
  }
  return { ok: false, stage, error: "unknown stage", retryable: false };
}
