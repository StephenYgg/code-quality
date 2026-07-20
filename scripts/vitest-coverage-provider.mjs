import { Session } from "node:inspector/promises";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const SCHEMA_VERSION = "1";
const MAX_SCRIPTS_PER_SUITE = 2_000;
const MAX_FUNCTIONS_PER_SUITE = 100_000;
const MAX_RANGES_PER_SUITE = 400_000;
const MAX_SUITE_BYTES = 8 * 1024 * 1024;
const MAX_RUN_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_FILES = 5_000;
const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_DIRECTORY_DEPTH = 32;
const INSPECTOR_SESSION = Symbol.for("code-quality.coverage.inspector-session");
const sourceRoot = resolve(process.cwd(), "src");
const sourceUrlPrefix = `${pathToFileURL(sourceRoot).href}/`;

async function startCoverage() {
  await stopCoverage();
  const session = new Session();
  globalThis[INSPECTOR_SESSION] = session;
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.startPreciseCoverage", {
    callCount: true,
    detailed: true,
  });
}

async function takeCoverage() {
  const session = globalThis[INSPECTOR_SESSION];
  if (session === undefined) return emptyPayload();
  const { result } = await session.post("Profiler.takePreciseCoverage");
  const scripts = result.filter(({ url }) => url.startsWith(sourceUrlPrefix));
  validateScripts(scripts);
  return { schemaVersion: SCHEMA_VERSION, scripts };
}

async function stopCoverage() {
  const session = globalThis[INSPECTOR_SESSION];
  if (session === undefined) return;
  delete globalThis[INSPECTOR_SESSION];
  try {
    await session.post("Profiler.stopPreciseCoverage");
    await session.post("Profiler.disable");
  } finally {
    session.disconnect();
  }
}

function emptyPayload() {
  return { schemaVersion: SCHEMA_VERSION, scripts: [] };
}

function validateScripts(scripts) {
  if (!Array.isArray(scripts) || scripts.length > MAX_SCRIPTS_PER_SUITE) {
    throw new Error("coverage script count exceeds its bound");
  }
  let functions = 0;
  let ranges = 0;
  for (const script of scripts) {
    if (
      script === null ||
      typeof script !== "object" ||
      typeof script.url !== "string" ||
      !script.url.startsWith(sourceUrlPrefix) ||
      !Array.isArray(script.functions)
    ) {
      throw new Error("coverage payload contains an invalid script");
    }
    functions += script.functions.length;
    for (const fn of script.functions) {
      if (!Array.isArray(fn.ranges)) {
        throw new Error("coverage payload contains an invalid function");
      }
      ranges += fn.ranges.length;
    }
  }
  if (functions > MAX_FUNCTIONS_PER_SUITE || ranges > MAX_RANGES_PER_SUITE) {
    throw new Error("coverage function or range count exceeds its bound");
  }
  if (Buffer.byteLength(JSON.stringify(scripts), "utf8") > MAX_SUITE_BYTES) {
    throw new Error("coverage payload exceeds its byte bound");
  }
}

class OfflineCoverageProvider {
  name = "custom";
  payloads = [];
  payloadBytes = 0;

  initialize(context) {
    this.context = context;
    const configured = context._coverageOptions;
    this.options = {
      ...configured,
      enabled: true,
      provider: "custom",
      reportsDirectory: resolve(
        context.config.root,
        configured.reportsDirectory || "coverage",
      ),
    };
  }

  resolveOptions() {
    return this.options;
  }

  async clean(clean = true) {
    const directory = this.options.reportsDirectory;
    await mkdir(directory, { recursive: true });
    if (clean) {
      await rm(join(directory, "coverage-summary.json"), { force: true });
    }
  }

  onAfterSuiteRun({ coverage }) {
    if (coverage === undefined) return;
    if (
      coverage === null ||
      typeof coverage !== "object" ||
      coverage.schemaVersion !== SCHEMA_VERSION ||
      !Array.isArray(coverage.scripts)
    ) {
      throw new Error("coverage provider received an invalid worker payload");
    }
    validateScripts(coverage.scripts);
    const bytes = Buffer.byteLength(JSON.stringify(coverage), "utf8");
    this.payloadBytes += bytes;
    if (this.payloadBytes > MAX_RUN_BYTES) {
      throw new Error("coverage run exceeds its aggregate byte bound");
    }
    this.payloads.push(coverage);
  }

  generateCoverage() {
    return this.payloads;
  }

  async reportCoverage(payloads) {
    const report = await buildReport(payloads);
    const destination = resolve(
      this.options.reportsDirectory,
      "coverage-summary.json",
    );
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid.toString()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    this.context.logger.log(formatSummary(report));
  }
}

async function buildReport(payloads) {
  const sourceFiles = await listSourceFiles(sourceRoot);
  const functionsByFile = new Map();
  for (const payload of payloads) {
    for (const script of payload.scripts) {
      const path = containedSourcePath(script.url);
      const functions = functionsByFile.get(path) ?? new Map();
      for (const fn of script.functions) {
        const root = fn.ranges[0];
        if (root === undefined) continue;
        const key = [fn.functionName, root.startOffset, root.endOffset].join(
          ":",
        );
        const covered = root.count > 0;
        functions.set(key, (functions.get(key) ?? false) || covered);
      }
      functionsByFile.set(path, functions);
    }
  }

  const files = sourceFiles.map((path) => {
    const functions = functionsByFile.get(path);
    return {
      path,
      moduleLoaded: functions !== undefined,
      functions: {
        covered:
          functions === undefined
            ? 0
            : [...functions.values()].filter(Boolean).length,
        total: functions?.size ?? 0,
      },
    };
  });
  const coveredFunctions = files.reduce(
    (sum, file) => sum + file.functions.covered,
    0,
  );
  const totalFunctions = files.reduce(
    (sum, file) => sum + file.functions.total,
    0,
  );
  const coveredModules = files.filter(
    ({ moduleLoaded }) => moduleLoaded,
  ).length;
  return {
    schemaVersion: SCHEMA_VERSION,
    metric: "v8-runtime-functions",
    limitations:
      "No source-map line or branch remapping; use behavior tests for changed critical branches.",
    files,
    totals: {
      modules: {
        covered: coveredModules,
        total: files.length,
        percentage: percentage(coveredModules, files.length),
      },
      functions: {
        covered: coveredFunctions,
        total: totalFunctions,
        percentage: percentage(coveredFunctions, totalFunctions),
      },
    },
  };
}

async function listSourceFiles(root) {
  const pending = [{ directory: root, depth: 0 }];
  const files = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > MAX_DIRECTORY_DEPTH) {
      throw new Error("coverage source tree exceeds its depth bound");
    }
    const entries = await readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(current.directory, entry.name);
      if (entry.isDirectory()) {
        pending.push({ directory: path, depth: current.depth + 1 });
      } else if (entry.isFile() && path.endsWith(".ts")) {
        const metadata = await stat(path);
        if (metadata.size > MAX_SOURCE_FILE_BYTES) {
          throw new Error("coverage source file exceeds its byte bound");
        }
        totalBytes += metadata.size;
        if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
          throw new Error("coverage source tree exceeds its byte bound");
        }
        const source = await readFile(path, "utf8");
        if (!hasRuntimeCode(path, source)) continue;
        files.push(relative(process.cwd(), path).split(sep).join("/"));
        if (files.length > MAX_SOURCE_FILES) {
          throw new Error("coverage source file count exceeds its bound");
        }
      }
    }
  }
  return files.sort();
}

function hasRuntimeCode(path, source) {
  if (path.endsWith(".d.ts")) return false;
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  return file.statements.some(statementHasRuntimeCode);
}

function statementHasRuntimeCode(statement) {
  if (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
    ) === true
  ) {
    return false;
  }
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name !== undefined) return true;
    const bindings = clause.namedBindings;
    return (
      bindings !== undefined &&
      (!ts.isNamedImports(bindings) ||
        bindings.elements.some((element) => !element.isTypeOnly))
    );
  }
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return false;
    const clause = statement.exportClause;
    return (
      clause === undefined ||
      !ts.isNamedExports(clause) ||
      clause.elements.some((element) => !element.isTypeOnly)
    );
  }
  return !ts.isEmptyStatement(statement);
}

function containedSourcePath(url) {
  const path = fileURLToPath(url);
  const relation = relative(sourceRoot, path);
  if (
    relation.length === 0 ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    resolve(sourceRoot, relation) !== path
  ) {
    throw new Error("coverage script escaped the source root");
  }
  return `src/${relation.split(sep).join("/")}`;
}

function percentage(covered, total) {
  return total === 0 ? 0 : Number(((covered / total) * 100).toFixed(1));
}

function formatSummary(report) {
  const modules = report.totals.modules;
  const functions = report.totals.functions;
  return [
    "Offline coverage (V8 runtime functions; no line/branch remap):",
    `  modules: ${modules.covered}/${modules.total} (${modules.percentage.toFixed(1)}%)`,
    `  observed functions: ${functions.covered}/${functions.total} (${functions.percentage.toFixed(1)}%)`,
  ].join("\n");
}

export default {
  getProvider: () => new OfflineCoverageProvider(),
  startCoverage,
  takeCoverage,
  stopCoverage,
};
