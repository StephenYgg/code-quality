import {
  BenchmarkRunError,
  runBenchmark,
  type BenchmarkRunResult,
} from "../benchmark/run.js";
import type { CommandOutputFormat } from "./output.js";

export async function runBenchmarkCommand(options: {
  readonly manifestPath: string;
  readonly observationsPath?: string;
  readonly format: CommandOutputFormat;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  try {
    const result = await runBenchmark(options);
    const gate = benchmarkGate(result);
    return {
      exitCode: gate === "BLOCK" ? 1 : gate === "INCOMPLETE" ? 3 : 0,
      output:
        options.format === "json"
          ? `${JSON.stringify({ gate, ...result }, null, 2)}\n`
          : renderTerminal(gate, result),
    };
  } catch (error) {
    if (error instanceof BenchmarkRunError) {
      return { exitCode: 2, output: `${error.code}: ${error.message}\n` };
    }
    throw error;
  }
}

function benchmarkGate(
  result: BenchmarkRunResult,
): "BLOCK" | "INCOMPLETE" | "PASS" | "WARN" {
  if (result.incompleteCaseIds.length > 0) return "INCOMPLETE";
  if (
    result.report.metrics.highSeverityMisses.length > 0 ||
    result.report.metrics.falseNegatives > 0
  ) {
    return "BLOCK";
  }
  if (
    result.report.metrics.falsePositives > 0 ||
    result.report.metrics.duplicateCount > 0 ||
    result.report.metrics.repeatRunStability < 1
  ) {
    return "WARN";
  }
  return "PASS";
}

function renderTerminal(
  gate: ReturnType<typeof benchmarkGate>,
  result: BenchmarkRunResult,
): string {
  const metrics = result.report.metrics;
  return [
    `Gate: ${gate}`,
    `Cases: exact=${metrics.exactCases.toString()} partial=${metrics.partialCases.toString()} missed=${metrics.missedCases.toString()} falsePositive=${metrics.falsePositiveCases.toString()}`,
    `Precision: ${(metrics.precision * 100).toFixed(1)}%`,
    `Recall: ${(metrics.recall * 100).toFixed(1)}%`,
    `False-positive rate: ${(metrics.falsePositiveRate * 100).toFixed(1)}%`,
    `Duplicate rate: ${(metrics.duplicateRate * 100).toFixed(1)}%`,
    `Repeat stability: ${(metrics.repeatRunStability * 100).toFixed(1)}%`,
    `High-severity misses: ${metrics.highSeverityMisses.length.toString()}`,
    `Incomplete cases: ${result.incompleteCaseIds.length.toString()}`,
    `Versions: provider=${result.report.metadata.provider} model=${result.report.metadata.model} prompt=${result.report.metadata.promptVersion} rules=${result.report.metadata.ruleVersion}`,
    "",
  ].join("\n");
}
