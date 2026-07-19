export type FindingSeverity = "P0" | "P1" | "P2" | "P3" | "NIT";
export type FindingLifecycle =
  | "candidate"
  | "corroborated"
  | "confirmed"
  | "dismissed"
  | "uncertain"
  | "waived"
  | "reported";
export type FindingDisposition =
  "new" | "preexisting" | "unknown" | "not_applicable";

export interface FindingLocation {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface Finding {
  readonly id: string;
  readonly ruleId?: string;
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly lifecycle: FindingLifecycle;
  readonly disposition: FindingDisposition;
  readonly confidence: "low" | "medium" | "high";
  readonly stages: readonly string[];
  readonly location?: FindingLocation;
  readonly evidence: string;
  readonly impact: string;
  readonly remediation: string;
}

export type FindingGate = "PASS" | "WARN" | "BLOCK" | "INCOMPLETE";

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  NIT: 4,
};

const LEGAL_TRANSITIONS: Readonly<
  Record<FindingLifecycle, readonly FindingLifecycle[]>
> = {
  candidate: ["corroborated", "dismissed", "uncertain", "waived"],
  corroborated: ["confirmed", "dismissed", "uncertain", "waived"],
  confirmed: ["reported", "waived"],
  dismissed: [],
  uncertain: ["corroborated", "dismissed", "waived"],
  waived: ["reported"],
  reported: [],
};

export class FindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingError";
  }
}

export function transitionFinding(
  finding: Finding,
  next: FindingLifecycle,
): Finding {
  const allowed = LEGAL_TRANSITIONS[finding.lifecycle];
  if (!allowed.includes(next)) {
    throw new FindingError(
      `Illegal finding transition ${finding.lifecycle} -> ${next}`,
    );
  }
  return Object.freeze({ ...finding, lifecycle: next });
}

export function createFinding(
  input: Omit<Finding, "lifecycle"> & { readonly lifecycle?: FindingLifecycle },
): Finding {
  return Object.freeze({
    ...input,
    lifecycle: input.lifecycle ?? "candidate",
    stages: Object.freeze([...input.stages]),
    ...(input.location === undefined
      ? {}
      : { location: Object.freeze({ ...input.location }) }),
  });
}

export function sortFindings(findings: readonly Finding[]): readonly Finding[] {
  return [...findings].sort((left, right) => {
    const severity =
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (severity !== 0) return severity;
    return left.id.localeCompare(right.id);
  });
}

export function decideGate(options: {
  readonly findings: readonly Finding[];
  readonly incomplete: boolean;
  readonly blockSeverities?: readonly FindingSeverity[];
}): FindingGate {
  if (options.incomplete) return "INCOMPLETE";
  const block = new Set(options.blockSeverities ?? ["P0", "P1"]);
  const confirmed = options.findings.filter(
    (finding) =>
      finding.lifecycle === "confirmed" || finding.lifecycle === "reported",
  );
  if (confirmed.some((finding) => block.has(finding.severity))) {
    return "BLOCK";
  }
  if (confirmed.some((finding) => finding.severity === "P2")) {
    return "WARN";
  }
  return "PASS";
}

export function dedupeFindings(
  findings: readonly Finding[],
): readonly Finding[] {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    const key = [
      finding.ruleId ?? "",
      finding.location?.path ?? "",
      finding.location?.startLine ?? "",
      finding.title,
    ].join("\0");
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, finding);
      continue;
    }
    const stages = Object.freeze([
      ...new Set([...existing.stages, ...finding.stages]),
    ]);
    const prefer =
      SEVERITY_RANK[finding.severity] < SEVERITY_RANK[existing.severity]
        ? finding
        : existing;
    byKey.set(
      key,
      Object.freeze({
        ...prefer,
        stages,
        evidence:
          prefer.evidence.length >= existing.evidence.length
            ? prefer.evidence
            : existing.evidence,
      }),
    );
  }
  return sortFindings([...byKey.values()]);
}
