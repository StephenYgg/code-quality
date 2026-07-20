import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { parseDocument } from "yaml";

import { evaluateReadability } from "../analysis/readability.js";
import { analyzeTypeScriptSource } from "../analysis/typescript-analyzer.js";
import { readBoundedUtf8File } from "../core/bounded-file.js";
import {
  createBenchmarkReport,
  type BenchmarkLabel,
  type BenchmarkObservation,
  type BenchmarkReport,
} from "./evaluate.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_OBSERVATIONS_BYTES = 4 * 1024 * 1024;
const MAX_FIXTURE_BYTES = 4 * 1024 * 1024;
const MAX_CASES = 256;
const ID_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,127}$/iu;

export type BenchmarkRunErrorCode =
  | "BENCHMARK_FIXTURE_INVALID"
  | "BENCHMARK_MANIFEST_INVALID"
  | "BENCHMARK_OBSERVATIONS_INVALID";

export class BenchmarkRunError extends Error {
  constructor(
    readonly code: BenchmarkRunErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BenchmarkRunError";
  }
}

interface BenchmarkCase extends BenchmarkLabel {
  readonly domain: string;
  readonly runner: "external" | "readability";
  readonly fixture: string;
}

interface BenchmarkManifest {
  readonly promptVersion: string;
  readonly ruleVersion: string;
  readonly cases: readonly BenchmarkCase[];
}

interface ExternalObservations {
  readonly provider: string;
  readonly model: string;
  readonly observations: readonly BenchmarkObservation[];
}

export interface BenchmarkRunResult {
  readonly report: BenchmarkReport;
  readonly observations: readonly BenchmarkObservation[];
  readonly incompleteCaseIds: readonly string[];
}

export async function runBenchmark(options: {
  readonly manifestPath: string;
  readonly observationsPath?: string;
  readonly generatedAt?: string;
}): Promise<BenchmarkRunResult> {
  const manifest = await loadManifest(options.manifestPath);
  const external =
    options.observationsPath === undefined
      ? undefined
      : await loadObservations(options.observationsPath);
  validateObservationIds(manifest.cases, external?.observations ?? []);
  const externalById = new Map(
    external?.observations.map((observation) => [observation.id, observation]),
  );
  const root = dirname(resolve(options.manifestPath));
  const observations: BenchmarkObservation[] = [];
  const incompleteCaseIds: string[] = [];

  for (const benchmarkCase of manifest.cases) {
    const fixturePath = containedFixturePath(root, benchmarkCase.fixture);
    const source = await readFixture(fixturePath, benchmarkCase.id);
    if (benchmarkCase.runner === "readability") {
      const observation = readabilityObservation(benchmarkCase, source);
      observations.push(observation.value);
      if (!observation.complete) incompleteCaseIds.push(benchmarkCase.id);
      continue;
    }
    const observation = externalById.get(benchmarkCase.id);
    if (observation === undefined) {
      observations.push({ id: benchmarkCase.id, reportedFindingIds: [] });
      incompleteCaseIds.push(benchmarkCase.id);
    } else {
      observations.push(observation);
    }
  }

  const report = createBenchmarkReport(manifest.cases, observations, {
    schemaVersion: "1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    provider: external?.provider ?? "deterministic",
    model: external?.model ?? "typescript-readability",
    promptVersion: manifest.promptVersion,
    ruleVersion: manifest.ruleVersion,
  });
  return {
    report,
    observations,
    incompleteCaseIds: incompleteCaseIds.sort(),
  };
}

async function loadManifest(path: string): Promise<BenchmarkManifest> {
  let source: string;
  try {
    source = await readBoundedUtf8File(path, MAX_MANIFEST_BYTES);
  } catch {
    throw new BenchmarkRunError(
      "BENCHMARK_MANIFEST_INVALID",
      "Benchmark manifest could not be read within limits",
    );
  }
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new BenchmarkRunError(
      "BENCHMARK_MANIFEST_INVALID",
      "Benchmark manifest YAML is invalid",
    );
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new BenchmarkRunError(
      "BENCHMARK_MANIFEST_INVALID",
      "Benchmark manifest aliases are not allowed",
    );
  }
  return parseManifestValue(value);
}

function parseManifestValue(value: unknown): BenchmarkManifest {
  const root = recordValue(value, "manifest");
  exactKeys(root, ["schemaVersion", "versions", "cases"], "manifest");
  if (root.schemaVersion !== 1) invalidManifest("schemaVersion must be 1");
  const versions = recordValue(root.versions, "versions");
  exactKeys(versions, ["prompt", "rules"], "versions");
  const promptVersion = boundedText(versions.prompt, "versions.prompt");
  const ruleVersion = boundedText(versions.rules, "versions.rules");
  if (!Array.isArray(root.cases) || root.cases.length > MAX_CASES) {
    invalidManifest(`cases must contain at most ${MAX_CASES.toString()} items`);
  }
  const cases = root.cases.map(parseCase);
  if (new Set(cases.map(({ id }) => id)).size !== cases.length) {
    invalidManifest("case IDs must be unique");
  }
  return { promptVersion, ruleVersion, cases };
}

function parseCase(value: unknown, index: number): BenchmarkCase {
  const item = recordValue(value, `cases[${index.toString()}]`);
  exactKeys(
    item,
    [
      "id",
      "domain",
      "runner",
      "fixture",
      "expectedFindingIds",
      "highSeverityFindingIds",
    ],
    `cases[${index.toString()}]`,
    ["highSeverityFindingIds"],
  );
  const id = boundedId(item.id, "case ID");
  const expectedFindingIds = idArray(
    item.expectedFindingIds,
    `${id}.expectedFindingIds`,
  );
  const highSeverityFindingIds =
    item.highSeverityFindingIds === undefined
      ? []
      : idArray(item.highSeverityFindingIds, `${id}.highSeverityFindingIds`);
  if (
    highSeverityFindingIds.some(
      (finding) => !expectedFindingIds.includes(finding),
    )
  ) {
    invalidManifest(`${id} high-severity findings must also be expected`);
  }
  if (item.runner !== "external" && item.runner !== "readability") {
    invalidManifest(`${id}.runner must be external or readability`);
  }
  return {
    id,
    domain: boundedText(item.domain, `${id}.domain`),
    runner: item.runner,
    fixture: boundedText(item.fixture, `${id}.fixture`),
    expectedFindingIds,
    ...(highSeverityFindingIds.length === 0 ? {} : { highSeverityFindingIds }),
  };
}

async function loadObservations(path: string): Promise<ExternalObservations> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readBoundedUtf8File(path, MAX_OBSERVATIONS_BYTES),
    ) as unknown;
  } catch {
    throw new BenchmarkRunError(
      "BENCHMARK_OBSERVATIONS_INVALID",
      "Benchmark observations could not be parsed within limits",
    );
  }
  const root = recordValue(value, "observations");
  exactKeys(
    root,
    ["schemaVersion", "provider", "model", "observations"],
    "observations",
  );
  if (root.schemaVersion !== "1" || !Array.isArray(root.observations)) {
    invalidObservations("Observations schemaVersion or array is invalid");
  }
  const observations = root.observations.map(parseObservation);
  if (new Set(observations.map(({ id }) => id)).size !== observations.length) {
    invalidObservations("Observation IDs must be unique");
  }
  return {
    provider: boundedText(root.provider, "provider"),
    model: boundedText(root.model, "model"),
    observations,
  };
}

function parseObservation(value: unknown, index: number): BenchmarkObservation {
  const item = recordValue(value, `observations[${index.toString()}]`);
  exactKeys(
    item,
    [
      "id",
      "reportedFindingIds",
      "repeatReportedFindingIds",
      "latencyMs",
      "inputTokens",
      "outputTokens",
    ],
    `observations[${index.toString()}]`,
    ["repeatReportedFindingIds", "latencyMs", "inputTokens", "outputTokens"],
  );
  const repeats = item.repeatReportedFindingIds;
  if (
    repeats !== undefined &&
    (!Array.isArray(repeats) || repeats.length > 20)
  ) {
    invalidObservations("repeatReportedFindingIds exceeds its limit");
  }
  return {
    id: boundedId(item.id, "observation ID"),
    reportedFindingIds: idArray(item.reportedFindingIds, "reportedFindingIds"),
    ...(repeats === undefined
      ? {}
      : {
          repeatReportedFindingIds: repeats.map((run) =>
            idArray(run, "repeat finding IDs"),
          ),
        }),
    ...optionalCount(item.latencyMs, "latencyMs"),
    ...optionalCount(item.inputTokens, "inputTokens"),
    ...optionalCount(item.outputTokens, "outputTokens"),
  };
}

function readabilityObservation(
  benchmarkCase: BenchmarkCase,
  source: string,
): { readonly complete: boolean; readonly value: BenchmarkObservation } {
  const analysis = analyzeTypeScriptSource(benchmarkCase.fixture, source);
  const readability = evaluateReadability(analysis);
  return {
    complete: analysis.complete && readability.gate !== "INCOMPLETE",
    value: {
      id: benchmarkCase.id,
      reportedFindingIds: [
        ...new Set(readability.candidates.map(({ ruleId }) => ruleId)),
      ].sort(),
    },
  };
}

function containedFixturePath(root: string, fixture: string): string {
  const candidate = resolve(root, fixture);
  const relation = relative(root, candidate);
  if (
    isAbsolute(fixture) ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new BenchmarkRunError(
      "BENCHMARK_FIXTURE_INVALID",
      "Benchmark fixture must remain inside the manifest directory",
    );
  }
  return candidate;
}

async function readFixture(path: string, id: string): Promise<string> {
  try {
    return await readBoundedUtf8File(path, MAX_FIXTURE_BYTES);
  } catch {
    throw new BenchmarkRunError(
      "BENCHMARK_FIXTURE_INVALID",
      `Benchmark fixture for ${id} is missing, unstable, or oversized`,
    );
  }
}

function validateObservationIds(
  cases: readonly BenchmarkCase[],
  observations: readonly BenchmarkObservation[],
): void {
  const caseIds = new Set(cases.map(({ id }) => id));
  if (observations.some(({ id }) => !caseIds.has(id))) {
    invalidObservations("Observations contain an unknown case ID");
  }
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidManifest(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  if (
    Object.keys(value).some((key) => !allowedSet.has(key)) ||
    allowed.some((key) => !optionalSet.has(key) && !(key in value))
  ) {
    invalidManifest(`${field} has missing or unknown keys`);
  }
}

function boundedText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 1024 ||
    value.includes("\0")
  ) {
    invalidManifest(`${field} is invalid or oversized`);
  }
  return value;
}

function boundedId(value: unknown, field: string): string {
  const id = boundedText(value, field);
  if (!ID_PATTERN.test(id)) invalidManifest(`${field} has an invalid format`);
  return id;
}

function idArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    invalidManifest(`${field} must contain at most 128 IDs`);
  }
  const ids = value.map((item) => boundedId(item, field));
  if (new Set(ids).size !== ids.length)
    invalidManifest(`${field} has duplicates`);
  return ids;
}

function optionalCount(value: unknown, field: string): Record<string, number> {
  if (value === undefined) return {};
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalidObservations(`${field} must be a nonnegative safe integer`);
  }
  return { [field]: value as number };
}

function invalidManifest(message: string): never {
  throw new BenchmarkRunError("BENCHMARK_MANIFEST_INVALID", message);
}

function invalidObservations(message: string): never {
  throw new BenchmarkRunError("BENCHMARK_OBSERVATIONS_INVALID", message);
}
