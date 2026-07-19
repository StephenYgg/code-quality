import type { RatingAnchors, ScoreMinorModel } from "./scoring-types.js";

export const RATING_ANCHOR_KEYS = [
  "0.0",
  "1.0",
  "2.0",
  "3.0",
  "4.0",
  "5.0",
] as const;
export const MAX_DOMAIN_VOCABULARY_ITEMS = 32;
export const MIN_DOMAIN_TERM_CODE_POINTS = 3;
export const MAX_DOMAIN_TERM_CODE_POINTS = 160;
export const MIN_RATING_ANCHOR_CODE_POINTS = 24;
export const MAX_RATING_ANCHOR_CODE_POINTS = 2_000;

type AnchorDefinition = readonly [
  name: string,
  failure: string,
  completeEvidence: string,
];

const DEFINITIONS: Readonly<Record<string, AnchorDefinition>> = {
  "intent-contract": [
    "Intent and contract alignment",
    "implementation behavior contradicts the declared requirement or public contract",
    "requirements, public contracts, implementation, and behavior tests agree",
  ],
  "primary-path": [
    "Primary path behavior",
    "a principal user or system flow is incorrect, incomplete, or unreachable",
    "every principal flow is traceable end to end and verified by behavior tests",
  ],
  "boundaries-invalid-input": [
    "Boundary and invalid input behavior",
    "nulls, limits, malformed values, or illegal inputs produce undefined behavior",
    "boundary cases and invalid inputs have explicit, tested outcomes",
  ],
  "failure-timeout-retry-cancellation": [
    "Failure, timeout, retry, and cancellation",
    "dependency failures are swallowed, misclassified, retried without budget, or ignore cancellation",
    "failure classes, timeout budgets, retries, and cancellation semantics are explicit and tested",
  ],
  "state-side-effects-idempotency": [
    "State, side effects, and idempotency",
    "illegal transitions or repeated calls create inconsistent state or duplicate side effects",
    "state transitions, transaction boundaries, side-effect ownership, and idempotency are proven",
  ],
  "naming-intent-domain-language": [
    "Naming, intent, and domain language",
    "ambiguous or inconsistent names hide business meaning and side effects",
    "names consistently expose business intent, predicates, units, ownership, and side effects",
  ],
  "function-responsibility-size": [
    "Function responsibility and size",
    "functions combine unrelated business stages and cannot be changed locally",
    "functions have coherent responsibilities and sizes justified by a visible domain workflow",
  ],
  "control-flow-visible-stages": [
    "Control flow and visible business stages",
    "deep or interleaved branching obscures execution order and business phases",
    "guards and named stages make every significant branch and phase directly traceable",
  ],
  "conditional-fallback-clarity": [
    "Conditional and fallback priority clarity",
    "nested conditionals or fallback chains hide business precedence",
    "precedence is explicit, named, and independently testable for every fallback source",
  ],
  "try-catch-error-boundaries": [
    "Try/catch and error boundaries",
    "broad catch regions combine unrelated failures or convert blocking errors into generic results",
    "catch boundaries align with recoverable stages and preserve typed failure meaning",
  ],
  "state-return-types-result-shapes": [
    "State, return types, and result shapes",
    "implicit states or inconsistent object shapes force callers to infer legal outcomes",
    "discriminated states and stable result types express every legal outcome",
  ],
  "cohesion-responsibility-ownership": [
    "Cohesion, responsibility, and ownership",
    "a module mixes unrelated change reasons or has no clear owner for behavior and state",
    "each module has one coherent change reason and explicit behavior and state ownership",
  ],
  "dependency-direction-layering": [
    "Dependency direction and layering",
    "dependencies cross architectural layers or create cycles that bypass policy boundaries",
    "dependency direction follows declared layers and cycle checks cover architectural boundaries",
  ],
  "public-interfaces-encapsulation": [
    "Public interfaces and encapsulation",
    "public APIs expose internal storage, SDK, or mutable implementation details",
    "small stable interfaces hide internal representation and constrain valid operations",
  ],
  "shared-state-lifecycle-ownership": [
    "Shared-state and lifecycle ownership",
    "shared state has multiple writers or an ambiguous creation, mutation, and cleanup lifecycle",
    "one owner controls shared state through an explicit bounded lifecycle",
  ],
  "abstraction-value-duplication": [
    "Abstraction value and duplication",
    "parallel abstractions or repeated rules create competing sources of truth",
    "abstractions remove meaningful duplication without hiding domain decisions",
  ],
  "observable-behavior-coverage": [
    "Observable behavior coverage",
    "important externally observable behavior has no credible automated verification",
    "behavior tests cover every changed contract and principal observable outcome",
  ],
  "failure-boundary-coverage": [
    "Failure and boundary coverage",
    "failure paths and boundary values are untested or asserted only through implementation details",
    "deterministic tests cover invalid input, limits, dependency failures, and recovery",
  ],
  "concurrency-timing-coverage": [
    "Concurrency and timing coverage",
    "race-sensitive behavior relies on uncontrolled Promise timing or has no interleaving tests",
    "tests control relevant interleavings, time, cancellation, and duplicate execution",
  ],
  "determinism-isolation": [
    "Determinism and test isolation",
    "tests depend on order, wall-clock time, random state, or shared mutable fixtures",
    "time, randomness, network, and state are controlled and every test is independently repeatable",
  ],
  "integration-contract-coverage": [
    "Integration and contract coverage",
    "module mocks omit real boundary semantics and allow incompatible integrations to pass",
    "integration and contract tests verify schemas, protocols, persistence, and provider boundaries",
  ],
  "hot-path-amplification-capacity": [
    "Hot-path amplification and capacity model",
    "request volume fans out into unbounded jobs, calls, records, or retained resources",
    "peak QPS, per-request fan-out, retention, and capacity limits are quantified and enforced",
  ],
  "race-atomicity-toctou": [
    "Race, atomicity, and TOCTOU protection",
    "check-then-act or read-modify-write sequences permit concurrent winners or lost updates",
    "transactions, uniqueness, CAS, or atomic acquisition prove single-winner semantics",
  ],
  "lock-scope-ownership-contention": [
    "Lock scope, ownership, and contention",
    "lock keys, TTL, ownership, release, or waiter behavior can reopen races or cause pile-ups",
    "lock scope, owner tokens, renewal, release, and waiter bounds are tested under contention",
  ],
  "single-flight-idempotency-deduplication": [
    "Single-flight, idempotency, and deduplication",
    "duplicate callers can execute side effects or leave loser-created resources",
    "one atomic winner owns execution while losers reuse results or back off without residue",
  ],
  "bounded-work-retries-queues-backpressure": [
    "Bounded work, retries, queues, and backpressure",
    "queues, workers, retries, timers, or task chains grow with traffic without a hard budget",
    "concurrency, queue depth, batch size, retry budget, cancellation, and backpressure are enforced",
  ],
  "multi-instance-stampede-resource-bounds": [
    "Multi-instance behavior, stampede, and resource bounds",
    "local coordination is mistaken for global safety or shared expiry causes a stampede",
    "cross-instance coordination, jitter, cleanup, and worst-case memory and storage bounds are proven",
  ],
  "authentication-authorization-tenant-isolation": [
    "Authentication, authorization, and tenant isolation",
    "identity is trusted without verification or resource access bypasses tenant and scope checks",
    "authentication and server-side authorization prove tenant, owner, and scope isolation",
  ],
  "input-injection-path-url-file-safety": [
    "Input, injection, path, URL, and file safety",
    "untrusted input reaches commands, queries, paths, URLs, templates, or files without contextual validation",
    "length, type, allowlist, containment, SSRF, injection, and output-encoding controls are tested",
  ],
  "secrets-privacy-logging-retention-deletion": [
    "Secrets, privacy, logging, retention, and deletion",
    "credentials or sensitive data can leak through code, logs, reports, caches, or excess retention",
    "data minimization, redaction, encryption, retention, and deletion controls cover every data path",
  ],
  "trust-boundaries-exfiltration-least-privilege": [
    "Trust boundaries, exfiltration, and least privilege",
    "untrusted content controls privileged actions, provider destinations, or data disclosure",
    "trust boundaries, destination controls, least privilege, and exfiltration defenses are explicit",
  ],
  "api-event-schema-compatibility": [
    "API, event, and schema compatibility",
    "a contract change breaks existing producers, consumers, or stored payloads without versioning",
    "consumer tests and schema checks prove forward and backward compatibility or explicit versioning",
  ],
  "data-migration-multi-version-behavior": [
    "Data migration and multi-version behavior",
    "migration or mixed-version deployment can corrupt, duplicate, or make data unreadable",
    "migrations are resumable and mixed-version read/write behavior is verified",
  ],
  "configuration-release-rollback-deprecation": [
    "Configuration, release, rollback, and deprecation",
    "defaults, rollout order, rollback, or deprecation behavior is unsafe or undocumented",
    "configuration validation, staged release, rollback, and deprecation cleanup are operationally proven",
  ],
  "errors-logs-metrics-traces-alerts": [
    "Errors, logs, metrics, traces, and alerts",
    "production failures cannot be correlated, classified, measured, or alerted by user impact",
    "safe structured errors, correlation, metrics, traces, and actionable alerts cover critical outcomes",
  ],
  "documentation-repository-hygiene-operability": [
    "Documentation, repository hygiene, and operability",
    "documentation misstates behavior or repository artifacts prevent repeatable operation and review",
    "commands, Agent instruction reuse, runbooks, generated files, and operational limits are current",
  ],
  "dependencies-licenses-provenance-release-integrity": [
    "Dependencies, licenses, provenance, and release integrity",
    "unverified dependencies, licenses, artifacts, or release inputs undermine supply-chain integrity",
    "locked provenance, vulnerability and license checks, reproducible builds, and release attestations are verified",
  ],
};

export const DEFAULT_RATING_ANCHORS: Readonly<Record<string, RatingAnchors>> =
  Object.fromEntries(
    Object.entries(DEFINITIONS).map(([id, definition]) => [
      id,
      createRatingAnchors(...definition),
    ]),
  );

export function hasValidRatingAnchors(
  minor: Pick<ScoreMinorModel, "domainVocabulary" | "id" | "name"> & {
    readonly ratingAnchors: unknown;
  },
): boolean {
  const ratingAnchors = minor.ratingAnchors;
  if (!isRecord(ratingAnchors)) return false;
  const keys = Object.keys(ratingAnchors).sort();
  const expectedKeys = [...RATING_ANCHOR_KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index])
  ) {
    return false;
  }

  if (!hasValidDomainVocabulary(minor.domainVocabulary)) return false;
  const domainTerms = minor.domainVocabulary.map(normalizeText);
  const normalizedAnchors: string[] = [];
  for (const key of RATING_ANCHOR_KEYS) {
    const value = ratingAnchors[key];
    if (
      typeof value !== "string" ||
      Array.from(value).length > MAX_RATING_ANCHOR_CODE_POINTS
    ) {
      return false;
    }
    normalizedAnchors.push(normalizeText(value));
  }
  return (
    new Set(normalizedAnchors).size === RATING_ANCHOR_KEYS.length &&
    normalizedAnchors.every(
      (anchor) =>
        Array.from(anchor).length >= MIN_RATING_ANCHOR_CODE_POINTS &&
        !hasTemplatePlaceholder(anchor) &&
        domainTerms.some((term) => anchor.includes(term)),
    )
  );
}

export function hasValidDomainVocabulary(
  value: unknown,
): value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_DOMAIN_VOCABULARY_ITEMS
  ) {
    return false;
  }
  if (
    !value.every(
      (term: unknown) =>
        typeof term === "string" &&
        Array.from(term).length <= MAX_DOMAIN_TERM_CODE_POINTS,
    )
  ) {
    return false;
  }
  const normalized = value.map((term: unknown) =>
    typeof term === "string" ? normalizeText(term) : "",
  );
  return (
    normalized.every(
      (term) =>
        Array.from(term).length >= MIN_DOMAIN_TERM_CODE_POINTS &&
        !hasTemplatePlaceholder(term),
    ) && new Set(normalized).size === normalized.length
  );
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function hasTemplatePlaceholder(value: string): boolean {
  return (
    /\b(?:example|fixme|lorem|placeholder|tbd|template|todo)\b/iu.test(value) ||
    /\b(?:replace|fill)\s+(?:it\s+)?later\b/iu.test(value) ||
    ["n/a", "none", "not applicable", "unknown"].includes(value)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRatingAnchors(
  name: string,
  failure: string,
  completeEvidence: string,
): RatingAnchors {
  return {
    "0.0": `${name}: ${failure}; reliable review is impossible or a critical failure is confirmed.`,
    "1.0": `${name}: ${failure} is prevalent; safe change depends on tests or author knowledge.`,
    "2.0": `${name}: ${failure} materially obstructs proof; ${completeEvidence} cannot yet be established.`,
    "3.0": `${name}: partial evidence exists, but ${failure} still creates material maintenance cost.`,
    "4.0": `${name}: ${completeEvidence}, with one small localized gap that does not block change.`,
    "5.0": `${name}: ${completeEvidence}; evidence is complete and no material gap remains.`,
  };
}
