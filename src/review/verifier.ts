import {
  createFinding,
  transitionFinding,
  type Finding,
  type FindingSeverity,
} from "../core/findings.js";
import type { ReviewSnapshot } from "../core/snapshots.js";

export interface ProviderCandidate {
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly evidence: string;
  readonly path?: string;
  readonly startLine?: number;
  readonly impact?: string;
  readonly remediation?: string;
}

export function verifyCandidates(
  stageId: string,
  candidates: readonly ProviderCandidate[],
  snapshot: ReviewSnapshot,
): readonly Finding[] {
  const paths = new Set(snapshot.files.map((file) => file.path));
  const findings: Finding[] = [];
  for (const [index, candidate] of candidates.entries()) {
    let finding = createFinding({
      id: `${stageId}-${String(index + 1)}`,
      title: candidate.title,
      severity: candidate.severity,
      disposition: "unknown",
      confidence: "low",
      stages: [stageId],
      evidence: candidate.evidence,
      impact: candidate.impact ?? "See evidence",
      remediation: candidate.remediation ?? "See evidence",
      ...(candidate.path === undefined
        ? {}
        : {
            location: {
              path: candidate.path,
              ...(candidate.startLine === undefined
                ? {}
                : { startLine: candidate.startLine }),
            },
          }),
    });

    const hasPath = candidate.path !== undefined && paths.has(candidate.path);
    const hasEvidence = candidate.evidence.trim().length >= 8;
    if (hasEvidence && (candidate.path === undefined || hasPath)) {
      finding = transitionFinding(finding, "corroborated");
      finding = transitionFinding(finding, "confirmed");
      finding = {
        ...finding,
        confidence: hasPath ? "high" : "medium",
        disposition: "new",
      };
    } else if (hasEvidence) {
      finding = transitionFinding(finding, "uncertain");
      finding = { ...finding, confidence: "low" };
    } else {
      finding = transitionFinding(finding, "dismissed");
    }
    findings.push(Object.freeze(finding));
  }
  return Object.freeze(findings);
}
