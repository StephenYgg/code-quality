import { compareCodeUnits } from "./deterministic-order.js";
import { canonicalizePolicy } from "./policy-values.js";

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
  readonly trigger?: string;
  readonly actualBehavior?: string;
  readonly expectedBehavior?: string;
  readonly verification?: string;
  readonly blockingVerificationUnresolved?: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly createdAt?: string;
}

export type FindingGate = "PASS" | "WARN" | "BLOCK" | "INCOMPLETE";

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  NIT: 4,
};

const CONFIDENCE_RANK: Readonly<Record<Finding["confidence"], number>> = {
  high: 0,
  medium: 1,
  low: 2,
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
    createdAt: input.createdAt ?? new Date().toISOString(),
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
    return compareCodeUnits(left.id, right.id);
  });
}

export function decideGate(options: {
  readonly findings: readonly Finding[];
  readonly incomplete: boolean;
  readonly blockSeverities?: readonly FindingSeverity[];
  readonly gateMode?: "advisory" | "block" | "warn";
  readonly blockSeverity?: "P0" | "P1" | "P2";
  readonly minimumConfidence?: "deterministic" | "high" | "low" | "medium";
}): FindingGate {
  if (options.incomplete) return "INCOMPLETE";
  const confirmed = options.findings.filter(
    (finding) =>
      finding.lifecycle === "confirmed" || finding.lifecycle === "reported",
  );
  if (options.gateMode !== undefined) {
    const confidenceRank = { low: 0, medium: 1, high: 2 } as const;
    let minimum: number = confidenceRank.high;
    if (options.minimumConfidence === "deterministic") minimum = 2;
    else if (options.minimumConfidence !== undefined) {
      minimum = confidenceRank[options.minimumConfidence];
    }
    const eligible = confirmed.filter(
      (finding) => confidenceRank[finding.confidence] >= minimum,
    );
    const material = eligible.filter((finding) =>
      ["P0", "P1", "P2"].includes(finding.severity),
    );
    if (options.gateMode !== "block") {
      return material.length > 0 ? "WARN" : "PASS";
    }
    const blockSeverity = options.blockSeverity;
    const threshold =
      SEVERITY_RANK[blockSeverity === undefined ? "P1" : blockSeverity];
    if (
      material.some((finding) => SEVERITY_RANK[finding.severity] <= threshold)
    ) {
      return "BLOCK";
    }
    return material.length > 0 ? "WARN" : "PASS";
  }
  const blockSeverities = options.blockSeverities;
  const block = new Set(
    blockSeverities === undefined ? ["P0", "P1"] : blockSeverities,
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
  const byKey = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = findingDeduplicationKey(finding);
    const group = byKey.get(key);
    if (group === undefined) byKey.set(key, [finding]);
    else group.push(finding);
  }
  return sortFindings([...byKey.values()].map(mergeFindingGroup));
}

function findingDeduplicationKey(finding: Finding): string {
  const values: (string | number)[] = ["", "", "", ""];
  if (finding.ruleId !== undefined) values[0] = finding.ruleId;
  if (finding.location !== undefined) {
    values[1] = finding.location.path;
    if (finding.location.startLine !== undefined) {
      values[2] = finding.location.startLine;
    }
    if (finding.location.endLine !== undefined) {
      values[3] = finding.location.endLine;
    }
  }
  values.push(normalizeFindingTitle(finding.title));
  return values.join("\0");
}

function mergeFindingGroup(group: readonly Finding[]): Finding {
  const first = group[0];
  if (first === undefined) throw new FindingError("Finding group is empty");
  if (group.length === 1) return first;
  const severityConflict = new Set(group.map((item) => item.severity)).size > 1;
  const lifecycle = mergedLifecycle(group, severityConflict);
  const canonical = canonicalFinding(group);
  const { blockingVerificationUnresolved, ...canonicalFields } = canonical;
  void blockingVerificationUnresolved;
  const verification = severityConflict
    ? "Conflicting duplicate candidates require adjudication"
    : preferredOptionalText(
        lifecycleAuthorities(group, lifecycle).map((item) => item.verification),
      );
  return Object.freeze({
    ...canonicalFields,
    severity: preferredSeverity(group),
    lifecycle,
    confidence:
      lifecycle === "uncertain"
        ? "low"
        : preferredConfidence(lifecycleAuthorities(group, lifecycle)),
    stages: Object.freeze(
      [...new Set(group.flatMap((item) => item.stages))].sort(compareCodeUnits),
    ),
    evidence: preferredText(group.map((item) => item.evidence)),
    ...(verification === undefined ? {} : { verification }),
    ...(lifecycle === "corroborated" &&
    group.some((item) => item.blockingVerificationUnresolved === true)
      ? { blockingVerificationUnresolved: true }
      : {}),
  });
}

function mergedLifecycle(
  group: readonly Finding[],
  severityConflict: boolean,
): FindingLifecycle {
  if (severityConflict) return "uncertain";
  const lifecycles = new Set(group.map((item) => item.lifecycle));
  if (lifecycles.has("waived")) return "waived";
  if (lifecycles.has("reported")) return "reported";
  if (lifecycles.has("confirmed")) return "confirmed";
  if (lifecycles.has("corroborated")) return "corroborated";
  if (lifecycles.has("uncertain")) return "uncertain";
  if (lifecycles.has("candidate")) return "candidate";
  return "dismissed";
}

function lifecycleAuthorities(
  group: readonly Finding[],
  lifecycle: FindingLifecycle,
): readonly Finding[] {
  const authorities = group.filter((item) => item.lifecycle === lifecycle);
  return authorities.length > 0 ? authorities : group;
}

function preferredSeverity(group: readonly Finding[]): FindingSeverity {
  return group.reduce(
    (preferred, item) =>
      SEVERITY_RANK[item.severity] < SEVERITY_RANK[preferred]
        ? item.severity
        : preferred,
    group[0]?.severity ?? "NIT",
  );
}

function preferredConfidence(group: readonly Finding[]): Finding["confidence"] {
  return group.reduce(
    (preferred, item) =>
      CONFIDENCE_RANK[item.confidence] < CONFIDENCE_RANK[preferred]
        ? item.confidence
        : preferred,
    group[0]?.confidence ?? "low",
  );
}

function canonicalFinding(group: readonly Finding[]): Finding {
  const first = group[0];
  if (first === undefined) throw new FindingError("Finding group is empty");
  return group
    .slice(1)
    .reduce(
      (preferred, item) =>
        compareCodeUnits(findingTieKey(item), findingTieKey(preferred)) < 0
          ? item
          : preferred,
      first,
    );
}

function findingTieKey(finding: Finding): string {
  return canonicalizePolicy({
    finding: stableFindingProjection(finding),
    provider: finding.provider ?? null,
    model: finding.model ?? null,
    createdAt: finding.createdAt ?? null,
  });
}

function preferredText(values: readonly string[]): string {
  return values.reduce((preferred, value) => {
    if (value.length !== preferred.length) {
      return value.length > preferred.length ? value : preferred;
    }
    return compareCodeUnits(value, preferred) < 0 ? value : preferred;
  });
}

function preferredOptionalText(
  values: readonly (string | undefined)[],
): string | undefined {
  const present = values.filter(
    (value): value is string => value !== undefined,
  );
  return present.length === 0 ? undefined : preferredText(present);
}

export function normalizeFindingTitle(title: string): string {
  return title.normalize("NFKC").trim().toLowerCase();
}

export function stableFindingProjection(finding: Finding): unknown {
  return {
    id: finding.id,
    ruleId: finding.ruleId ?? null,
    title: finding.title,
    severity: finding.severity,
    lifecycle: finding.lifecycle,
    disposition: finding.disposition,
    confidence: finding.confidence,
    stages: [...finding.stages].sort(compareCodeUnits),
    location:
      finding.location === undefined
        ? null
        : {
            path: finding.location.path,
            startLine: finding.location.startLine ?? null,
            endLine: finding.location.endLine ?? null,
          },
    evidence: finding.evidence,
    impact: finding.impact,
    remediation: finding.remediation,
    trigger: finding.trigger ?? null,
    actualBehavior: finding.actualBehavior ?? null,
    expectedBehavior: finding.expectedBehavior ?? null,
    verification: finding.verification ?? null,
    blockingVerificationUnresolved:
      finding.blockingVerificationUnresolved === true,
  };
}

export function dispositionFromSnapshotStatus(
  status: string | undefined,
): FindingDisposition {
  if (status === "added") return "new";
  if (status === "renamed") return "preexisting";
  return "unknown";
}
