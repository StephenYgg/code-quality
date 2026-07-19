import { createHash, randomUUID } from "node:crypto";

import {
  decideGate,
  dedupeFindings,
  sortFindings,
  type Finding,
  type FindingGate,
} from "../core/findings.js";
import type { ReviewSnapshot } from "../core/snapshots.js";
import type {
  ProviderReviewResponse,
  ReviewProvider,
} from "../providers/provider.js";
import { planReview, type ReviewPlan } from "./planner.js";
import {
  buildStagePrompt,
  PROMPT_BUNDLE_VERSION,
  STAGE_OUTPUT_SCHEMA,
} from "./prompts.js";
import { verifyCandidates, type ProviderCandidate } from "./verifier.js";

export interface ReviewRunResult {
  readonly runId: string;
  readonly gate: FindingGate;
  readonly findings: readonly Finding[];
  readonly uncertain: readonly Finding[];
  readonly waived: readonly Finding[];
  readonly plan: ReviewPlan;
  readonly snapshot: ReviewSnapshot;
  readonly incomplete: boolean;
  readonly providerAttempts: number;
  readonly promptBundleVersion: string;
  readonly reportHash: string;
}

export interface ReviewOrchestratorOptions {
  readonly provider: ReviewProvider;
  readonly snapshot: ReviewSnapshot;
  readonly signal?: AbortSignal;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
}

function asCandidates(content: unknown): readonly ProviderCandidate[] {
  if (content === null || typeof content !== "object") return [];
  const record = content as { readonly candidates?: unknown };
  if (!Array.isArray(record.candidates)) {
    // Fake providers may return { findings: [...] } for smoke tests.
    const findings = (content as { readonly findings?: unknown }).findings;
    if (Array.isArray(findings)) {
      return findings.flatMap((item, index) => {
        if (item === null || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        if (typeof row.title !== "string" || typeof row.severity !== "string") {
          return [];
        }
        return [
          {
            title: row.title,
            severity: row.severity as ProviderCandidate["severity"],
            evidence:
              typeof row.evidence === "string"
                ? row.evidence
                : `provider-finding-${String(index)}`,
            ...(typeof row.path === "string" ? { path: row.path } : {}),
          },
        ];
      });
    }
    return [];
  }
  return record.candidates.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (
      typeof row.title !== "string" ||
      typeof row.severity !== "string" ||
      typeof row.evidence !== "string"
    ) {
      return [];
    }
    return [
      {
        title: row.title,
        severity: row.severity as ProviderCandidate["severity"],
        evidence: row.evidence,
        ...(typeof row.path === "string" ? { path: row.path } : {}),
        ...(typeof row.startLine === "number"
          ? { startLine: row.startLine }
          : {}),
        ...(typeof row.impact === "string" ? { impact: row.impact } : {}),
        ...(typeof row.remediation === "string"
          ? { remediation: row.remediation }
          : {}),
      },
    ];
  });
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 0)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) continue;
        results[index] = await worker(item);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export async function runReview(
  options: ReviewOrchestratorOptions,
): Promise<ReviewRunResult> {
  const runId = randomUUID();
  const plan = planReview(options.snapshot);
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) controller.abort();

  let providerAttempts = 0;
  let incomplete = options.snapshot.incomplete;
  const allFindings: Finding[] = [];

  try {
    const stageResults = await mapPool(
      plan.stages,
      plan.maxInFlight,
      async (stage) => {
        if (controller.signal.aborted) {
          incomplete = true;
          return [] as Finding[];
        }
        const prompt = buildStagePrompt(stage, options.snapshot);
        try {
          providerAttempts += 1;
          if (providerAttempts > plan.maxAttempts) {
            incomplete = true;
            return [];
          }
          const response: ProviderReviewResponse =
            await options.provider.review({
              runId,
              stageId: stage,
              model: "default",
              systemInstructions: prompt.systemInstructions,
              untrustedContext: prompt.untrustedContext,
              outputSchema: STAGE_OUTPUT_SCHEMA,
              maxOutputTokens: options.maxOutputTokens ?? 2_000,
              timeoutMs: options.timeoutMs ?? 30_000,
              maxRequestBytes: 512 * 1024,
              maxResponseBytes: 512 * 1024,
              maxDiagnosticBytes: 64 * 1024,
              signal: controller.signal,
              attemptBudget: { maxAttempts: 2, used: 0 },
            });
          providerAttempts += response.attemptsUsed - 1;
          return [
            ...verifyCandidates(
              stage,
              asCandidates(response.content),
              options.snapshot,
            ),
          ];
        } catch {
          incomplete = true;
          return [];
        }
      },
    );
    for (const findings of stageResults) allFindings.push(...findings);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }

  const deduped = dedupeFindings(allFindings);
  const confirmed = sortFindings(
    deduped.filter(
      (finding) =>
        finding.lifecycle === "confirmed" || finding.lifecycle === "reported",
    ),
  );
  const uncertain = sortFindings(
    deduped.filter((finding) => finding.lifecycle === "uncertain"),
  );
  const waived = sortFindings(
    deduped.filter((finding) => finding.lifecycle === "waived"),
  );
  const gate = decideGate({ findings: confirmed, incomplete });
  const reportHash = createHash("sha256")
    .update(runId)
    .update(options.snapshot.contentHash)
    .update(JSON.stringify(confirmed))
    .digest("hex");

  return Object.freeze({
    runId,
    gate,
    findings: confirmed,
    uncertain,
    waived,
    plan,
    snapshot: options.snapshot,
    incomplete,
    providerAttempts,
    promptBundleVersion: PROMPT_BUNDLE_VERSION,
    reportHash,
  });
}
