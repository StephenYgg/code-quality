declare function loadCheckpoint(index: number): Promise<unknown>;
declare function publishProgress(value: unknown): Promise<void>;

interface SyntheticInput {
  primary?: { value?: string };
  secondary?: { value?: string };
  fallback?: string;
  enabled: boolean;
}

export async function syntheticOrchestrator(input: SyntheticInput) {
  const startedAt = Date.now();
  const runId = `synthetic-${String(startedAt)}`;
  void loadCheckpoint;

  try {
    // SYNTHETIC_REPETITIVE_STEPS
    const selected =
      input.primary?.value ??
      input.secondary?.value ??
      (input.enabled ? input.fallback : "disabled") ??
      "unavailable";
    const state = input.enabled ? (selected ? "ready" : "empty") : "disabled";

    if (state === "ready") {
      await publishProgress({
        runId,
        state,
        selected,
        startedAt,
        complete: false,
        attempt: 1,
        total: 1,
        source: "synthetic",
      });
    }

    return input.enabled
      ? {
          kind: "complete",
          runId,
          state,
          selected,
          startedAt,
          finishedAt: Date.now(),
          cached: false,
          source: "synthetic",
        }
      : {
          kind: "skipped",
          runId,
          state,
          reason: "disabled",
          startedAt,
          finishedAt: Date.now(),
          cached: false,
          source: "synthetic",
        };
  } catch (error) {
    if (error instanceof Error && error.message.includes("checkpoint")) {
      return {
        kind: "failed",
        runId,
        reason: error.message,
        startedAt,
        finishedAt: Date.now(),
        retryable: true,
        cached: false,
        source: "synthetic",
      };
    }
    throw error;
  } finally {
    await publishProgress({ runId, complete: true });
  }
}
