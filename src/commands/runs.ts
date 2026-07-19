import { listRuns } from "../storage/runs.js";
import type { CommandOutputFormat } from "./output.js";

export async function runRunsListCommand(
  format: CommandOutputFormat = "terminal",
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const runs = await listRuns();
  if (format === "json") {
    return {
      exitCode: 0,
      output: `${JSON.stringify(runs, null, 2)}\n`,
    };
  }
  if (runs.length === 0) {
    return { exitCode: 0, output: "No stored runs\n" };
  }
  const lines = runs.map(
    (run) =>
      `${run.runId}  gate=${run.gate}  kind=${run.inputKind}  hash=${run.reportHash.slice(0, 12)}`,
  );
  return { exitCode: 0, output: `${lines.join("\n")}\n` };
}
