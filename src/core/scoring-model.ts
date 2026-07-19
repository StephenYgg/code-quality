import { createHash } from "node:crypto";

import {
  DEFAULT_RATING_ANCHORS,
  hasValidDomainVocabulary,
  hasValidRatingAnchors,
  RATING_ANCHOR_KEYS,
} from "./scoring-rating-anchors.js";
import type {
  ScoreIssue,
  ScoreMajorModel,
  ScoreMinorModel,
  ScoreModel,
} from "./scoring-types.js";

const EXPECTED_MAJOR_IDS = [
  "correctness",
  "readability",
  "architecture",
  "testing",
  "concurrency",
  "security",
  "compatibility",
  "observability-docs-supply-chain",
] as const;
const MAX_SCORE_MINORS = 1_000;
const MAX_SCORE_MINORS_PER_MAJOR = 125;

function minor(
  id: string,
  name: string,
  weightTenths: number,
): ScoreMinorModel {
  const ratingAnchors = DEFAULT_RATING_ANCHORS[id];
  if (ratingAnchors === undefined) {
    throw new TypeError(`Missing default rating anchors for ${id}`);
  }
  return {
    id,
    name,
    weightTenths,
    required: true,
    domainVocabulary: [name],
    ratingAnchors,
  };
}

export const DEFAULT_SCORE_MODEL: ScoreModel = deepFreezeScoreModel({
  id: "cq-default",
  version: "1.0.0",
  ruleVersions: { "CQ-SCORE": "1.0.0" },
  roundingMode: "half_up",
  majors: [
    {
      id: "correctness",
      name: "Behavioral correctness",
      weightTenths: 200,
      minors: [
        minor("intent-contract", "Intent and contract alignment", 40),
        minor("primary-path", "Primary path behavior", 40),
        minor(
          "boundaries-invalid-input",
          "Boundary and invalid input behavior",
          40,
        ),
        minor(
          "failure-timeout-retry-cancellation",
          "Failure, timeout, retry, and cancellation",
          40,
        ),
        minor(
          "state-side-effects-idempotency",
          "State, side effects, and idempotency",
          40,
        ),
      ],
    },
    {
      id: "readability",
      name: "Human readability and changeability",
      weightTenths: 200,
      minors: [
        minor(
          "naming-intent-domain-language",
          "Naming, intent, and domain language",
          30,
        ),
        minor(
          "function-responsibility-size",
          "Function responsibility and size",
          40,
        ),
        minor(
          "control-flow-visible-stages",
          "Control flow and visible business stages",
          40,
        ),
        minor(
          "conditional-fallback-clarity",
          "Conditional and fallback priority clarity",
          30,
        ),
        minor(
          "try-catch-error-boundaries",
          "Try/catch and error boundaries",
          30,
        ),
        minor(
          "state-return-types-result-shapes",
          "State, return types, and result shapes",
          30,
        ),
      ],
    },
    {
      id: "architecture",
      name: "Module boundaries and architecture",
      weightTenths: 120,
      minors: [
        minor(
          "cohesion-responsibility-ownership",
          "Cohesion, responsibility, and ownership",
          30,
        ),
        minor(
          "dependency-direction-layering",
          "Dependency direction and layering",
          30,
        ),
        minor(
          "public-interfaces-encapsulation",
          "Public interfaces and encapsulation",
          20,
        ),
        minor(
          "shared-state-lifecycle-ownership",
          "Shared-state and lifecycle ownership",
          20,
        ),
        minor(
          "abstraction-value-duplication",
          "Abstraction value and duplication",
          20,
        ),
      ],
    },
    {
      id: "testing",
      name: "Testing and verifiability",
      weightTenths: 120,
      minors: [
        minor(
          "observable-behavior-coverage",
          "Observable behavior coverage",
          30,
        ),
        minor("failure-boundary-coverage", "Failure and boundary coverage", 30),
        minor(
          "concurrency-timing-coverage",
          "Concurrency and timing coverage",
          20,
        ),
        minor("determinism-isolation", "Determinism and test isolation", 20),
        minor(
          "integration-contract-coverage",
          "Integration and contract coverage",
          20,
        ),
      ],
    },
    {
      id: "concurrency",
      name: "Concurrency and resource safety",
      weightTenths: 120,
      minors: [
        minor(
          "hot-path-amplification-capacity",
          "Hot-path amplification and capacity model",
          20,
        ),
        minor(
          "race-atomicity-toctou",
          "Race, atomicity, and TOCTOU protection",
          20,
        ),
        minor(
          "lock-scope-ownership-contention",
          "Lock scope, ownership, and contention",
          20,
        ),
        minor(
          "single-flight-idempotency-deduplication",
          "Single-flight, idempotency, and deduplication",
          20,
        ),
        minor(
          "bounded-work-retries-queues-backpressure",
          "Bounded work, retries, queues, and backpressure",
          20,
        ),
        minor(
          "multi-instance-stampede-resource-bounds",
          "Multi-instance behavior, stampede, and resource bounds",
          20,
        ),
      ],
    },
    {
      id: "security",
      name: "Security and privacy",
      weightTenths: 120,
      minors: [
        minor(
          "authentication-authorization-tenant-isolation",
          "Authentication, authorization, and tenant isolation",
          30,
        ),
        minor(
          "input-injection-path-url-file-safety",
          "Input, injection, path, URL, and file safety",
          30,
        ),
        minor(
          "secrets-privacy-logging-retention-deletion",
          "Secrets, privacy, logging, retention, and deletion",
          30,
        ),
        minor(
          "trust-boundaries-exfiltration-least-privilege",
          "Trust boundaries, exfiltration, and least privilege",
          30,
        ),
      ],
    },
    {
      id: "compatibility",
      name: "API, data, and release compatibility",
      weightTenths: 60,
      minors: [
        minor(
          "api-event-schema-compatibility",
          "API, event, and schema compatibility",
          20,
        ),
        minor(
          "data-migration-multi-version-behavior",
          "Data migration and multi-version behavior",
          20,
        ),
        minor(
          "configuration-release-rollback-deprecation",
          "Configuration, release, rollback, and deprecation",
          20,
        ),
      ],
    },
    {
      id: "observability-docs-supply-chain",
      name: "Observability, documentation, and supply chain",
      weightTenths: 60,
      minors: [
        minor(
          "errors-logs-metrics-traces-alerts",
          "Errors, logs, metrics, traces, and alerts",
          20,
        ),
        minor(
          "documentation-repository-hygiene-operability",
          "Documentation, repository hygiene, and operability",
          20,
        ),
        minor(
          "dependencies-licenses-provenance-release-integrity",
          "Dependencies, licenses, provenance, and release integrity",
          20,
        ),
      ],
    },
  ],
});

export function deepFreezeScoreModel(model: ScoreModel): ScoreModel {
  Object.freeze(model.ruleVersions);
  for (const major of model.majors) {
    for (const item of major.minors) {
      Object.freeze(item.domainVocabulary);
      Object.freeze(item.ratingAnchors);
      Object.freeze(item);
    }
    Object.freeze(major.minors);
    Object.freeze(major);
  }
  Object.freeze(model.majors);
  return Object.freeze(model);
}

export function validateScoreModel(model: ScoreModel): readonly ScoreIssue[] {
  const issues: ScoreIssue[] = [];
  validateMetadata(model, issues);
  if (modelExceedsLimits(model, issues)) return issues;
  const majorIds = new Set<string>();
  const minorIds = new Set<string>();
  let majorTotal = 0;

  for (const [majorIndex, major] of model.majors.entries()) {
    const majorPath = `majors[${majorIndex.toString()}]`;
    validateNameAndId(major, majorPath, "major", majorIds, issues);
    validateWeight(
      major.weightTenths,
      `${majorPath}.weightTenths`,
      "major",
      issues,
    );
    majorTotal += Number.isInteger(major.weightTenths) ? major.weightTenths : 0;
    validateMinorModels(major, majorPath, minorIds, issues);
  }

  if (!sameIds(majorIds, EXPECTED_MAJOR_IDS)) {
    issues.push(
      issue(
        "MAJOR_SET_INVALID",
        "majors",
        "Score models must contain the eight standard major dimensions",
      ),
    );
  }
  if (majorTotal !== 1_000) {
    issues.push(
      issue(
        "MAJOR_TOTAL_INVALID",
        "majors",
        `Major weights total ${majorTotal.toString()}, expected 1000 tenths`,
      ),
    );
  }
  return issues;
}

function modelExceedsLimits(model: ScoreModel, issues: ScoreIssue[]): boolean {
  if (model.majors.length > EXPECTED_MAJOR_IDS.length) {
    issues.push(
      issue(
        "MODEL_LIMIT_EXCEEDED",
        "majors",
        `Score models are limited to ${EXPECTED_MAJOR_IDS.length.toString()} major dimensions`,
      ),
    );
    return true;
  }
  let minorCount = 0;
  for (const major of model.majors) {
    if (major.minors.length > MAX_SCORE_MINORS_PER_MAJOR) {
      issues.push(
        issue(
          "MODEL_LIMIT_EXCEEDED",
          "majors[].minors",
          `Each major dimension is limited to ${MAX_SCORE_MINORS_PER_MAJOR.toString()} minor items`,
        ),
      );
      return true;
    }
    minorCount += major.minors.length;
    if (minorCount > MAX_SCORE_MINORS) {
      issues.push(
        issue(
          "MODEL_LIMIT_EXCEEDED",
          "majors[].minors",
          `Score models are limited to ${MAX_SCORE_MINORS.toString()} minor items`,
        ),
      );
      return true;
    }
  }
  return false;
}

export function createModelCompatibilitySignature(model: ScoreModel): string {
  const semanticDefinition = {
    roundingMode: model.roundingMode,
    ruleVersions: Object.entries(model.ruleVersions).sort(compareEntries),
    majors: [...model.majors].sort(compareIds).map((major) => ({
      id: major.id,
      name: major.name,
      weightTenths: major.weightTenths,
      minors: [...major.minors].sort(compareIds).map((item) => ({
        id: item.id,
        name: item.name,
        weightTenths: item.weightTenths,
        required: item.required,
        domainVocabulary: [...item.domainVocabulary].sort(),
        ratingAnchors: RATING_ANCHOR_KEYS.map((key) => [
          key,
          item.ratingAnchors[key],
        ]),
      })),
    })),
  };
  return createHash("sha256")
    .update(JSON.stringify(semanticDefinition))
    .digest("hex");
}

function compareIds(
  left: { readonly id: string },
  right: { readonly id: string },
): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareEntries(
  left: readonly [string, string],
  right: readonly [string, string],
): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}

function validateMetadata(model: ScoreModel, issues: ScoreIssue[]): void {
  if (model.id.trim().length === 0)
    issues.push(issue("INVALID_MODEL_ID", "id", "Model ID cannot be empty"));
  if (model.version.trim().length === 0)
    issues.push(
      issue(
        "INVALID_MODEL_VERSION",
        "version",
        "Model version cannot be empty",
      ),
    );
  if (
    model.profileHash !== undefined &&
    model.profileHash.trim().length === 0
  ) {
    issues.push(
      issue(
        "INVALID_PROFILE_HASH",
        "profileHash",
        "Profile hash cannot be empty",
      ),
    );
  }
  if (model.roundingMode !== "half_up") {
    issues.push(
      issue(
        "INVALID_ROUNDING_MODE",
        "roundingMode",
        "Rounding mode must be half_up",
      ),
    );
  }
}

function validateMinorModels(
  major: ScoreMajorModel,
  majorPath: string,
  minorIds: Set<string>,
  issues: ScoreIssue[],
): void {
  let minorTotal = 0;
  for (const [minorIndex, item] of major.minors.entries()) {
    const minorPath = `${majorPath}.minors[${minorIndex.toString()}]`;
    validateNameAndId(item, minorPath, "minor", minorIds, issues);
    validateWeight(
      item.weightTenths,
      `${minorPath}.weightTenths`,
      "minor",
      issues,
    );
    minorTotal += Number.isInteger(item.weightTenths) ? item.weightTenths : 0;
    if (!hasValidDomainVocabulary(item.domainVocabulary)) {
      issues.push(
        issue(
          "INVALID_DOMAIN_VOCABULARY",
          `${minorPath}.domainVocabulary`,
          "Domain vocabulary must contain distinct substantive non-placeholder terms",
        ),
      );
    } else if (!hasValidRatingAnchors(item)) {
      issues.push(invalidRatingAnchorsIssue(minorPath));
    }
  }
  if (minorTotal !== major.weightTenths) {
    issues.push(
      issue(
        "MINOR_TOTAL_MISMATCH",
        `${majorPath}.minors`,
        `Minor weights total ${minorTotal.toString()}, expected ${major.weightTenths.toString()} tenths`,
      ),
    );
  }
}

function validateNameAndId(
  value: { readonly id: string; readonly name: string },
  path: string,
  kind: "major" | "minor",
  ids: Set<string>,
  issues: ScoreIssue[],
): void {
  if (value.id.trim().length === 0 || value.name.trim().length === 0) {
    issues.push(
      issue(
        kind === "major" ? "UNNAMED_MAJOR" : "UNNAMED_MINOR",
        `${path}.${value.id.trim().length === 0 ? "id" : "name"}`,
        `Every ${kind} must have a non-empty ID and name`,
      ),
    );
  }
  if (ids.has(value.id)) {
    issues.push(
      issue(
        kind === "major" ? "DUPLICATE_MAJOR_ID" : "DUPLICATE_MINOR_ID",
        `${path}.id`,
        `Duplicate ${kind} ID: ${value.id}`,
      ),
    );
  }
  ids.add(value.id);
}

function invalidRatingAnchorsIssue(minorPath: string): ScoreIssue {
  return issue(
    "INVALID_RATING_ANCHORS",
    `${minorPath}.ratingAnchors`,
    "Rating anchors must define non-placeholder 0.0 through 5.0 integer anchors exactly",
  );
}

function validateWeight(
  weightTenths: number,
  path: string,
  kind: "major" | "minor",
  issues: ScoreIssue[],
): void {
  if (!Number.isInteger(weightTenths) || weightTenths < 0) {
    issues.push(
      issue(
        kind === "major" ? "INVALID_MAJOR_WEIGHT" : "INVALID_MINOR_WEIGHT",
        path,
        "Weights must be non-negative integer tenths",
      ),
    );
  }
}

function sameIds(
  actual: ReadonlySet<string>,
  expected: readonly string[],
): boolean {
  return (
    actual.size === expected.length && expected.every((id) => actual.has(id))
  );
}

function issue(
  code: ScoreIssue["code"],
  path: string,
  message: string,
): ScoreIssue {
  return { code, path, message };
}
