export type ReviewStageId =
  | "universal"
  | "behavior"
  | "readability"
  | "testing"
  | "concurrency"
  | "security"
  | "permissions"
  | "data"
  | "cache"
  | "jobs"
  | "events"
  | "external_api"
  | "performance"
  | "compatibility"
  | "ui";

export const MANDATORY_STAGES: readonly ReviewStageId[] = [
  "universal",
  "behavior",
  "readability",
  "testing",
  "concurrency",
];

export const MAX_REVIEW_STAGES = 7;

export interface RiskSignals {
  readonly touchesAuth?: boolean;
  readonly touchesCrypto?: boolean;
  readonly touchesSql?: boolean;
  readonly touchesCache?: boolean;
  readonly touchesJobs?: boolean;
  readonly touchesEvents?: boolean;
  readonly touchesExternalApi?: boolean;
  readonly touchesUi?: boolean;
  readonly touchesSchema?: boolean;
  readonly performanceSensitive?: boolean;
}

export function routeStages(signals: RiskSignals): readonly ReviewStageId[] {
  const selected: ReviewStageId[] = [...MANDATORY_STAGES];
  const add = (stage: ReviewStageId): void => {
    if (!selected.includes(stage) && selected.length < MAX_REVIEW_STAGES) {
      selected.push(stage);
    }
  };
  if (signals.touchesAuth || signals.touchesCrypto) add("security");
  if (signals.touchesAuth) add("permissions");
  if (signals.touchesSql || signals.touchesSchema) add("data");
  if (signals.touchesCache) add("cache");
  if (signals.touchesJobs) add("jobs");
  if (signals.touchesEvents) add("events");
  if (signals.touchesExternalApi) add("external_api");
  if (signals.performanceSensitive) add("performance");
  if (signals.touchesSchema) add("compatibility");
  if (signals.touchesUi) add("ui");
  return Object.freeze(selected.slice(0, MAX_REVIEW_STAGES));
}

export function inferRiskSignals(paths: readonly string[]): RiskSignals {
  const joined = paths.join("\n").toLowerCase();
  return {
    touchesAuth: /auth|session|jwt|oauth|permission|rbac/.test(joined),
    touchesCrypto: /crypto|cipher|hash|hmac|secret|password/.test(joined),
    touchesSql: /sql|prisma|sequelize|typeorm|knex|migration/.test(joined),
    touchesCache: /cache|redis|memcache/.test(joined),
    touchesJobs: /queue|worker|job|bull|bee-queue/.test(joined),
    touchesEvents: /event|kafka|pubsub|sns|sqs/.test(joined),
    touchesExternalApi: /http|fetch|axios|webhook|client/.test(joined),
    touchesUi: /\.tsx$|\.jsx$|component|css|view/.test(joined),
    touchesSchema: /schema|migration|protobuf|openapi|graphql/.test(joined),
    performanceSensitive: /hotpath|benchmark|perf|latency/.test(joined),
  };
}
