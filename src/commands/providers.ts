import { soakUserProviders } from "../providers/soak.js";
import type { CommandOutputFormat } from "./output.js";

export async function runProvidersValidateCommand(options?: {
  readonly configPath?: string;
  readonly format?: CommandOutputFormat;
  readonly live?: boolean;
  readonly forgeTokenEnv?: string;
  readonly forge?: "github" | "gitlab";
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  try {
    const report = await soakUserProviders({
      ...(options?.configPath === undefined
        ? {}
        : { configPath: options.configPath }),
      ...(options?.live === true ? { live: true } : {}),
      ...(options?.forgeTokenEnv === undefined
        ? {}
        : { forgeTokenEnv: options.forgeTokenEnv }),
      ...(options?.forge === undefined ? {} : { forge: options.forge }),
    });
    if (options?.format === "json") {
      return {
        exitCode: report.ok ? 0 : 2,
        output: `${JSON.stringify(report, null, 2)}\n`,
      };
    }
    const lines = [
      `Provider soak: ${report.ok ? "PASS" : "FAIL"}`,
      `config: ${report.configPath}`,
      `live: ${report.liveEnabled ? "yes" : "no"}`,
      `probedAt: ${report.probedAt}`,
      "",
    ];
    for (const entry of report.entries) {
      lines.push(
        `- ${entry.name} (${entry.kind}): ${entry.ok ? "ok" : "FAIL"}${entry.version === undefined ? "" : ` version=${entry.version}`}${entry.live === undefined ? "" : entry.live.ok ? " live=ok" : " live=FAIL"}`,
      );
      for (const diagnostic of entry.diagnostics) {
        lines.push(`  [${diagnostic.code}] ${diagnostic.message}`);
      }
      if (entry.live?.detail !== undefined) {
        lines.push(`  detail: ${entry.live.detail}`);
      }
    }
    lines.push("");
    return { exitCode: report.ok ? 0 : 2, output: `${lines.join("\n")}\n` };
  } catch (error) {
    return {
      exitCode: 2,
      output: `${error instanceof Error ? error.message : "Provider soak failed"}\n`,
    };
  }
}
