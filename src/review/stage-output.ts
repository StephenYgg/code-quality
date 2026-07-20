import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import type { Finding, FindingSeverity } from "../core/findings.js";
import type { ReviewStageId } from "../core/risk-router.js";
import type { Assessment } from "../core/scoring-types.js";
import type { ReviewSnapshot } from "../core/snapshots.js";
import {
  ProviderError,
  type ProviderReviewRequest,
  type ReviewProvider,
} from "../providers/provider.js";
import type { ReviewContextBundle } from "./context.js";
import {
  materializeStageAssessments,
  minorsForStage,
  type ReviewAssessmentPlan,
} from "./assessment-plan.js";
import { buildStagePrompt } from "./prompts.js";
import { verifyCandidates } from "./verifier.js";
import type { BlockingEvidenceVerifier } from "./verifier.js";

export const MAX_STAGE_CANDIDATES = 64;
export const MAX_STAGE_LINE_NUMBER = 10_000_000;
const MAX_TITLE_LENGTH = 300;
const MAX_PATH_LENGTH = 4_096;
const MAX_EVIDENCE_LENGTH = 10_000;
const MIN_QUOTE_LENGTH = 8;
const MAX_STAGE_ASSESSMENTS = 1_000;
const MAX_ASSESSMENT_EVIDENCE = 16;
const DEFAULT_SCORE_STAGE_OUTPUT_TOKENS = 12_000;

export interface StageCandidate {
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly evidence: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly sourceQuote?: string;
  readonly contractFact?: string;
  readonly impact?: string;
  readonly remediation?: string;
}

export interface StageOutput {
  readonly candidates: readonly StageCandidate[];
  readonly assessments?: readonly StageAssessment[];
}

export interface StageAssessmentEvidence {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly sourceQuote: string;
}

export type StageAssessment =
  | {
      readonly minorId: string;
      readonly status: "scored";
      readonly rating: number;
      readonly confidence: "low" | "medium" | "high";
      readonly evidence: readonly StageAssessmentEvidence[];
      readonly explanation: string;
    }
  | {
      readonly minorId: string;
      readonly status: "not_applicable";
      readonly reason: string;
    };

export interface ReviewDiagnostic {
  readonly code:
    | "PROVIDER_RESPONSE_INVALID"
    | "PROVIDER_ATTEMPT_BUDGET_EXHAUSTED"
    | "PROVIDER_CONFIG_INVALID"
    | "PROVIDER_TIMEOUT"
    | "PROVIDER_ABORTED"
    | "PROVIDER_RESPONSE_TOO_LARGE"
    | "PROVIDER_NETWORK"
    | "PROVIDER_CAPACITY"
    | "PROVIDER_UNSAFE"
    | "PROVIDER_FAILED"
    | "RUN_STORAGE_CAPACITY_EXCEEDED"
    | "CACHE_CAPACITY_EXCEEDED"
    | "SINGLE_FLIGHT_RESULT_UNAVAILABLE"
    | "SINGLE_FLIGHT_WAITER_LIMIT"
    | "SINGLE_FLIGHT_TIMEOUT";
  readonly message: string;
  readonly stageId: string;
  readonly path?: string;
}

export interface AttemptReservation {
  readonly limit: 1 | 2;
  settle(used: number): void;
}

export interface StageExecutionOptions {
  readonly provider: ReviewProvider;
  readonly snapshot: ReviewSnapshot;
  readonly context?: ReviewContextBundle;
  readonly model?: string;
  readonly providerName?: string;
  readonly blockingEvidenceVerifier?: BlockingEvidenceVerifier;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly assessmentPlan?: ReviewAssessmentPlan;
}

export interface StageExecutionResult {
  readonly findings: readonly Finding[];
  readonly diagnostics: readonly ReviewDiagnostic[];
  readonly incomplete: boolean;
  readonly assessments?: readonly Assessment[];
}

export const STAGE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: MAX_STAGE_CANDIDATES,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "severity",
          "evidence",
          "path",
          "startLine",
          "endLine",
        ],
        anyOf: [{ required: ["sourceQuote"] }, { required: ["contractFact"] }],
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TITLE_LENGTH,
          },
          severity: {
            type: "string",
            enum: ["P0", "P1", "P2", "P3", "NIT"],
          },
          evidence: {
            type: "string",
            minLength: 12,
            maxLength: MAX_EVIDENCE_LENGTH,
          },
          path: {
            type: "string",
            minLength: 1,
            maxLength: MAX_PATH_LENGTH,
          },
          startLine: {
            type: "integer",
            minimum: 1,
            maximum: MAX_STAGE_LINE_NUMBER,
          },
          endLine: {
            type: "integer",
            minimum: 1,
            maximum: MAX_STAGE_LINE_NUMBER,
          },
          sourceQuote: {
            type: "string",
            minLength: MIN_QUOTE_LENGTH,
            maxLength: MAX_EVIDENCE_LENGTH,
          },
          contractFact: {
            type: "string",
            minLength: MIN_QUOTE_LENGTH,
            maxLength: MAX_EVIDENCE_LENGTH,
          },
          impact: {
            type: "string",
            minLength: 1,
            maxLength: MAX_EVIDENCE_LENGTH,
          },
          remediation: {
            type: "string",
            minLength: 1,
            maxLength: MAX_EVIDENCE_LENGTH,
          },
        },
      },
    },
    assessments: {
      type: "array",
      maxItems: MAX_STAGE_ASSESSMENTS,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: [
              "minorId",
              "status",
              "rating",
              "confidence",
              "evidence",
              "explanation",
            ],
            properties: {
              minorId: {
                type: "string",
                minLength: 1,
                maxLength: MAX_TITLE_LENGTH,
              },
              status: { const: "scored" },
              rating: {
                type: "number",
                minimum: 0,
                maximum: 5,
                multipleOf: 0.5,
              },
              confidence: {
                type: "string",
                enum: ["low", "medium", "high"],
              },
              evidence: {
                type: "array",
                minItems: 1,
                maxItems: MAX_ASSESSMENT_EVIDENCE,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["path", "startLine", "endLine", "sourceQuote"],
                  properties: {
                    path: {
                      type: "string",
                      minLength: 1,
                      maxLength: MAX_PATH_LENGTH,
                    },
                    startLine: {
                      type: "integer",
                      minimum: 1,
                      maximum: MAX_STAGE_LINE_NUMBER,
                    },
                    endLine: {
                      type: "integer",
                      minimum: 1,
                      maximum: MAX_STAGE_LINE_NUMBER,
                    },
                    sourceQuote: {
                      type: "string",
                      minLength: MIN_QUOTE_LENGTH,
                      maxLength: MAX_EVIDENCE_LENGTH,
                    },
                  },
                },
              },
              explanation: {
                type: "string",
                minLength: 1,
                maxLength: MAX_EVIDENCE_LENGTH,
                pattern: "\\S",
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["minorId", "status", "reason"],
            properties: {
              minorId: {
                type: "string",
                minLength: 1,
                maxLength: MAX_TITLE_LENGTH,
              },
              status: { const: "not_applicable" },
              reason: {
                type: "string",
                minLength: 1,
                maxLength: MAX_EVIDENCE_LENGTH,
                pattern: "\\S",
              },
            },
          },
        ],
      },
    },
  },
} as const;

const stageOutputValidator: ValidateFunction = new Ajv2020({
  allErrors: false,
  strict: false,
}).compile(STAGE_OUTPUT_SCHEMA as AnySchema);

function invalidDiagnostic(
  stageId: string,
  error: ErrorObject | null | undefined,
): ReviewDiagnostic {
  const instancePath = error?.instancePath || "/";
  const keyword = error?.keyword ?? "schema";
  return Object.freeze({
    code: "PROVIDER_RESPONSE_INVALID",
    stageId,
    path: instancePath,
    message: `Stage output failed schema validation at ${instancePath} (${keyword})`,
  });
}

function freezeCandidate(candidate: StageCandidate): StageCandidate {
  return Object.freeze({ ...candidate });
}

function freezeAssessment(assessment: StageAssessment): StageAssessment {
  if (assessment.status === "not_applicable") {
    return Object.freeze({ ...assessment });
  }
  return Object.freeze({
    ...assessment,
    evidence: Object.freeze(
      assessment.evidence.map((item) => Object.freeze({ ...item })),
    ),
  });
}

export type StageOutputValidation =
  | { readonly ok: true; readonly value: StageOutput }
  | { readonly ok: false; readonly diagnostic: ReviewDiagnostic };

export function validateStageOutput(
  stageId: string,
  content: unknown,
): StageOutputValidation {
  if (!stageOutputValidator(content)) {
    return Object.freeze({
      ok: false,
      diagnostic: invalidDiagnostic(stageId, stageOutputValidator.errors?.[0]),
    });
  }
  const output = content as StageOutput;
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      candidates: Object.freeze(output.candidates.map(freezeCandidate)),
      ...(output.assessments === undefined
        ? {}
        : {
            assessments: Object.freeze(
              output.assessments.map(freezeAssessment),
            ),
          }),
    }),
  });
}

function providerRequest(
  options: StageExecutionOptions,
  runId: string,
  stageId: string,
  prompt: ReturnType<typeof buildStagePrompt>,
  attemptLimit: 1 | 2,
  signal: AbortSignal,
): ProviderReviewRequest {
  return {
    runId,
    stageId,
    model: options.model ?? "default",
    systemInstructions: prompt.systemInstructions,
    untrustedContext: prompt.untrustedContext,
    outputSchema: STAGE_OUTPUT_SCHEMA,
    maxOutputTokens:
      options.maxOutputTokens ??
      (options.assessmentPlan === undefined
        ? 2_000
        : DEFAULT_SCORE_STAGE_OUTPUT_TOKENS),
    timeoutMs: options.timeoutMs ?? 30_000,
    maxRequestBytes: 768 * 1024,
    maxResponseBytes: 512 * 1024,
    maxDiagnosticBytes: 64 * 1024,
    signal,
    attemptBudget: { maxAttempts: attemptLimit, used: 0 },
  };
}

function errorDiagnostic(
  stageId: string,
  provider: ReviewProvider,
  error: unknown,
): ReviewDiagnostic {
  let message = "Provider stage failed";
  try {
    message = provider.redactDiagnostic(error).slice(0, 1_000);
  } catch {
    // A failing redactor must not hide the original stage failure.
  }
  return Object.freeze({
    code: error instanceof ProviderError ? error.code : "PROVIDER_FAILED",
    stageId,
    message,
  });
}

function repairPrompt(
  prompt: ReturnType<typeof buildStagePrompt>,
  diagnostic: ReviewDiagnostic,
): ReturnType<typeof buildStagePrompt> {
  return {
    ...prompt,
    systemInstructions: [
      prompt.systemInstructions,
      "The previous output was invalid. Return one corrected JSON object only.",
      `Validation: ${diagnostic.message}`,
    ].join("\n"),
  };
}

function assessmentDiagnostic(
  stageId: string,
  issueCount: number,
): ReviewDiagnostic {
  return Object.freeze({
    code: "PROVIDER_RESPONSE_INVALID",
    stageId,
    path: "/assessments",
    message: `Stage assessment output failed ${String(issueCount)} ownership or immutable evidence check(s)`,
  });
}

function validAttemptCount(value: unknown, remaining: number): value is 1 | 2 {
  return (value === 1 || value === 2) && value <= remaining;
}

export async function executeReviewStage(
  options: StageExecutionOptions,
  runId: string,
  stageId: ReviewStageId,
  signal: AbortSignal,
  reservation: AttemptReservation,
): Promise<StageExecutionResult> {
  let prompt = buildStagePrompt(
    stageId,
    options.snapshot,
    options.context,
    options.assessmentPlan === undefined
      ? undefined
      : minorsForStage(options.assessmentPlan, stageId),
  );
  let consumed = 0;
  const diagnostics: ReviewDiagnostic[] = [];
  try {
    while (consumed < reservation.limit) {
      const remaining = reservation.limit - consumed;
      const response = await options.provider.review(
        providerRequest(
          options,
          runId,
          stageId,
          prompt,
          remaining === 1 ? 1 : 2,
          signal,
        ),
      );
      if (!validAttemptCount(response.attemptsUsed, remaining)) {
        throw new ProviderError(
          "PROVIDER_RESPONSE_INVALID",
          "Provider reported attempts beyond its reserved budget",
        );
      }
      consumed += response.attemptsUsed;
      const validated = validateStageOutput(stageId, response.content);
      if (validated.ok) {
        const scoreOutput =
          options.assessmentPlan === undefined
            ? undefined
            : materializeStageAssessments({
                stageId,
                raw: validated.value.assessments,
                plan: options.assessmentPlan,
                snapshot: options.snapshot,
                ...(options.context === undefined
                  ? {}
                  : { context: options.context }),
              });
        reservation.settle(consumed);
        return {
          findings: verifyCandidates(
            stageId,
            validated.value.candidates,
            options.snapshot,
            options.context,
            {
              ...(options.providerName === undefined
                ? {}
                : { provider: options.providerName }),
              ...(options.model === undefined ? {} : { model: options.model }),
              ...(options.blockingEvidenceVerifier === undefined
                ? {}
                : {
                    blockingEvidenceVerifier: options.blockingEvidenceVerifier,
                  }),
            },
          ),
          diagnostics: Object.freeze([
            ...diagnostics,
            ...(scoreOutput === undefined || scoreOutput.issues.length === 0
              ? []
              : [assessmentDiagnostic(stageId, scoreOutput.issues.length)]),
          ]),
          incomplete: false,
          ...(scoreOutput === undefined
            ? {}
            : { assessments: scoreOutput.assessments }),
        };
      }
      diagnostics.push(validated.diagnostic);
      if (consumed < reservation.limit) {
        prompt = repairPrompt(prompt, validated.diagnostic);
      }
    }
    reservation.settle(consumed);
    return {
      findings: [],
      diagnostics: Object.freeze(diagnostics),
      incomplete: true,
    };
  } catch (error) {
    reservation.settle(reservation.limit);
    diagnostics.push(errorDiagnostic(stageId, options.provider, error));
    return {
      findings: [],
      diagnostics: Object.freeze(diagnostics),
      incomplete: true,
    };
  }
}
