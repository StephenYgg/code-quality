/**
 * Product hook presets: budgets, fail-open policy, and phase behavior.
 * Local hooks remain bypassable; they are not server-side enforcement.
 */

export type HookMode = "warn" | "block";
export type HookPreset = "balanced" | "strict";
export type HookPhase = "pre-commit" | "pre-push";
export type ReviewExecutionPreset = "fast" | "full";

export interface HookPhaseBudget {
  readonly maxFiles: number;
  readonly maxDurationMs: number;
  readonly maxProviderAttempts: number;
  readonly maxInFlight: number;
  readonly maxOutputTokens: number;
}

export interface HookPhaseConfig {
  /** staged | worktree | upstream_range (merge-base of @{upstream}..HEAD). */
  readonly input: "staged" | "worktree" | "upstream_range";
  readonly execution: ReviewExecutionPreset;
  readonly runDeterministicReadability: boolean;
  readonly budget: HookPhaseBudget;
}

export interface HookPresetDefinition {
  readonly id: HookPreset;
  readonly failOpenOnIncomplete: boolean;
  readonly preCommit: HookPhaseConfig;
  readonly prePush: HookPhaseConfig;
}

const FAST_BUDGET: HookPhaseBudget = Object.freeze({
  maxFiles: 40,
  maxDurationMs: 120_000,
  maxProviderAttempts: 6,
  maxInFlight: 1,
  maxOutputTokens: 1_200,
});

const FULL_BUDGET: HookPhaseBudget = Object.freeze({
  maxFiles: 200,
  maxDurationMs: 900_000,
  maxProviderAttempts: 16,
  maxInFlight: 2,
  maxOutputTokens: 2_000,
});

export const HOOK_PRESETS: Readonly<Record<HookPreset, HookPresetDefinition>> =
  Object.freeze({
    balanced: Object.freeze({
      id: "balanced",
      // Design default: incomplete provider/network failures do not block commits.
      failOpenOnIncomplete: true,
      preCommit: Object.freeze({
        input: "staged",
        execution: "fast",
        runDeterministicReadability: true,
        budget: FAST_BUDGET,
      }),
      prePush: Object.freeze({
        input: "upstream_range",
        execution: "full",
        runDeterministicReadability: true,
        budget: FULL_BUDGET,
      }),
    }),
    strict: Object.freeze({
      id: "strict",
      failOpenOnIncomplete: true,
      preCommit: Object.freeze({
        input: "staged",
        execution: "full",
        runDeterministicReadability: true,
        budget: FULL_BUDGET,
      }),
      prePush: Object.freeze({
        input: "upstream_range",
        execution: "full",
        runDeterministicReadability: true,
        budget: FULL_BUDGET,
      }),
    }),
  });

export function resolveHookPreset(value: string | undefined): HookPreset {
  return value === "strict" ? "strict" : "balanced";
}

export function resolveHookMode(value: string | undefined): HookMode {
  return value === "block" ? "block" : "warn";
}

/**
 * Map a review CLI exit code into the final hook process exit code.
 *
 * - warn: always 0 (never blocks commit/push)
 * - block: keep gate BLOCK (1) and config errors (2)
 * - block + incomplete (3) + fail-open: 0 with caller-printed warning
 */
export function resolveHookExitCode(options: {
  readonly mode: HookMode;
  readonly reviewExitCode: number;
  readonly failOpenOnIncomplete: boolean;
}): {
  readonly exitCode: number;
  readonly note?: string;
} {
  if (options.mode === "warn") {
    if (options.reviewExitCode === 0) {
      return { exitCode: 0 };
    }
    return {
      exitCode: 0,
      note: `warn mode: review exit ${String(options.reviewExitCode)} did not block the git operation`,
    };
  }
  if (options.reviewExitCode === 3 && options.failOpenOnIncomplete) {
    return {
      exitCode: 0,
      note: "INCOMPLETE review: fail-open allowed the git operation; do not treat this as a clean review",
    };
  }
  return { exitCode: options.reviewExitCode };
}

export function phaseConfigFor(
  preset: HookPreset,
  phase: HookPhase,
): HookPhaseConfig {
  const definition = HOOK_PRESETS[preset];
  return phase === "pre-commit" ? definition.preCommit : definition.prePush;
}
