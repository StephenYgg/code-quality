import { PolicyDiagnosticCollector } from "./policy-diagnostics.js";
import { createPolicyDocumentValidator } from "./policy-schema.js";
import type { PolicyDiagnostic } from "./policy-types.js";

export const MAX_WAIVERS_PER_MATCH = 1_000;

export interface WaiverRuleVersion {
  readonly minimum: number;
  readonly maximum: number;
}

export interface WaiverScope {
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly changes?: readonly string[];
  readonly findings?: readonly string[];
}

export interface Waiver {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: WaiverRuleVersion;
  readonly repository: string;
  readonly scope: WaiverScope;
  readonly reason: string;
  readonly riskAcceptance: string;
  readonly approver: string;
  readonly owner: string;
  readonly compensatingControls: readonly string[];
  readonly trackingIssue: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface WaiverMatchContext {
  readonly repository: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly path?: string;
  readonly symbol?: string;
  readonly changeId?: string;
  readonly findingId?: string;
}

export interface ValidatedWaivers {
  readonly values: readonly Waiver[];
  readonly entries: readonly ValidatedWaiverEntry[];
  readonly diagnostics: readonly PolicyDiagnostic[];
}

export interface ValidatedWaiverEntry {
  readonly waiver: Waiver;
  readonly source: string;
}

function semanticDiagnostic(
  code: string,
  source: string,
  path: string,
  message: string,
): PolicyDiagnostic {
  return { code, source, path, message };
}

const UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u;

function strictUtcTimestamp(value: string): number | undefined {
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) {
    return undefined;
  }
  const parts = match.slice(1).map((part) => Number(part));
  const [year, month, day, hour, minute, second, millisecond = 0] = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return undefined;
  }
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(hour, minute, second, millisecond);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second &&
    parsed.getUTCMilliseconds() === millisecond
    ? parsed.getTime()
    : undefined;
}

function validateWaiverSemantics(
  waiver: Waiver,
  now: Date,
  source: string,
): readonly PolicyDiagnostic[] {
  const diagnostics: PolicyDiagnostic[] = [];
  if (waiver.ruleVersion.minimum > waiver.ruleVersion.maximum) {
    diagnostics.push(
      semanticDiagnostic(
        "WAIVER_VERSION_RANGE_INVALID",
        source,
        "/ruleVersion",
        "Waiver minimum rule version must not exceed its maximum",
      ),
    );
  }
  const createdAt = strictUtcTimestamp(waiver.createdAt);
  const expiresAt = strictUtcTimestamp(waiver.expiresAt);
  if (createdAt === undefined) {
    diagnostics.push(
      semanticDiagnostic(
        "WAIVER_TIMESTAMP_INVALID",
        source,
        "/createdAt",
        "Waiver creation time is not a valid UTC timestamp",
      ),
    );
  }
  if (expiresAt === undefined) {
    diagnostics.push(
      semanticDiagnostic(
        "WAIVER_TIMESTAMP_INVALID",
        source,
        "/expiresAt",
        "Waiver expiry time is not a valid UTC timestamp",
      ),
    );
  } else if (expiresAt <= now.getTime()) {
    diagnostics.push(
      semanticDiagnostic(
        "WAIVER_EXPIRED",
        source,
        "/expiresAt",
        "Waiver has expired and cannot affect the gate",
      ),
    );
  }
  if (
    createdAt !== undefined &&
    expiresAt !== undefined &&
    createdAt >= expiresAt
  ) {
    diagnostics.push(
      semanticDiagnostic(
        "WAIVER_TIME_RANGE_INVALID",
        source,
        "/expiresAt",
        "Waiver expiry must be later than its creation time",
      ),
    );
  }
  return diagnostics;
}

export function validateWaiverInputs(
  values: readonly unknown[],
  now: Date = new Date(),
  sources?: readonly string[],
  diagnostics = new PolicyDiagnosticCollector(),
): ValidatedWaivers {
  if (!Number.isFinite(now.getTime())) {
    diagnostics.add([
      semanticDiagnostic(
        "WAIVER_NOW_INVALID",
        "waivers",
        "/now",
        "Waiver evaluation time must be a valid date",
      ),
    ]);
    return {
      values: [],
      entries: [],
      diagnostics: diagnostics.toArray(),
    };
  }
  if (values.length > MAX_WAIVERS_PER_MATCH) {
    diagnostics.add([
      semanticDiagnostic(
        "WAIVER_LIMIT_EXCEEDED",
        "waivers",
        "",
        `Waiver validation accepts at most ${String(MAX_WAIVERS_PER_MATCH)} values`,
      ),
    ]);
    return {
      values: [],
      entries: [],
      diagnostics: diagnostics.toArray(),
    };
  }
  const validateSchema = createPolicyDocumentValidator<Waiver>("waiver");
  const validated: Waiver[] = [];
  const entries: ValidatedWaiverEntry[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (diagnostics.exhausted) {
      break;
    }
    const source = sources?.[index] ?? `waivers[${String(index)}]`;
    const result = validateSchema(values[index], source);
    if (!diagnostics.add(result.diagnostics)) {
      break;
    }
    if (result.value !== undefined) {
      const semantic = validateWaiverSemantics(result.value, now, source);
      diagnostics.add(semantic);
      if (semantic.length === 0) {
        validated.push(result.value);
        entries.push({ waiver: result.value, source });
      }
    }
  }
  return { values: validated, entries, diagnostics: diagnostics.toArray() };
}

export function validateWaiver(
  value: unknown,
  now: Date = new Date(),
): readonly PolicyDiagnostic[] {
  return validateWaiverInputs([value], now, ["waiver"]).diagnostics;
}

function normalizeRepositoryPath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return undefined;
  }
  return normalized;
}

function pathMatches(pattern: string, candidate: string): boolean {
  const normalizedPattern = normalizeRepositoryPath(pattern);
  const normalizedCandidate = normalizeRepositoryPath(candidate);
  if (normalizedPattern === undefined || normalizedCandidate === undefined) {
    return false;
  }
  if (normalizedPattern.endsWith("/**")) {
    const directory = normalizedPattern.slice(0, -3);
    return (
      normalizedCandidate === directory ||
      normalizedCandidate.startsWith(`${directory}/`)
    );
  }
  if (normalizedPattern.endsWith("/*")) {
    const directory = normalizedPattern.slice(0, -2);
    if (!normalizedCandidate.startsWith(`${directory}/`)) {
      return false;
    }
    return !normalizedCandidate.slice(directory.length + 1).includes("/");
  }
  return normalizedPattern === normalizedCandidate;
}

function optionalScopeMatches(
  expected: readonly string[] | undefined,
  actual: string | undefined,
  matcher: (expectedValue: string, actualValue: string) => boolean,
): boolean {
  if (expected === undefined) {
    return true;
  }
  return (
    actual !== undefined && expected.some((value) => matcher(value, actual))
  );
}

function waiverMatches(waiver: Waiver, context: WaiverMatchContext): boolean {
  return (
    waiver.repository === context.repository &&
    waiver.ruleId === context.ruleId &&
    context.ruleVersion >= waiver.ruleVersion.minimum &&
    context.ruleVersion <= waiver.ruleVersion.maximum &&
    optionalScopeMatches(waiver.scope.paths, context.path, pathMatches) &&
    optionalScopeMatches(
      waiver.scope.symbols,
      context.symbol,
      (expected, actual) => expected === actual,
    ) &&
    optionalScopeMatches(
      waiver.scope.changes,
      context.changeId,
      (expected, actual) => expected === actual,
    ) &&
    optionalScopeMatches(
      waiver.scope.findings,
      context.findingId,
      (expected, actual) => expected === actual,
    )
  );
}

export function findApplicableWaivers(
  waivers: readonly unknown[],
  context: WaiverMatchContext,
  now: Date = new Date(),
): readonly Waiver[] {
  if (waivers.length > MAX_WAIVERS_PER_MATCH) {
    throw new RangeError(
      `Waiver matching accepts at most ${String(MAX_WAIVERS_PER_MATCH)} waivers`,
    );
  }
  const validated = validateWaiverInputs(waivers, now);
  return validated.values.filter((waiver) => waiverMatches(waiver, context));
}
