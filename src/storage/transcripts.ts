import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { redactSecrets } from "../providers/provider.js";
import { transcriptsDirectory } from "./paths.js";

export async function retainReviewTranscript(options: {
  readonly runId: string;
  readonly body: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<string> {
  if (!/^[0-9a-f-]{36}$/iu.test(options.runId)) {
    throw new Error("Run id is invalid for transcript retention");
  }
  const directory = transcriptsDirectory(options.env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${options.runId}.transcript.txt`);
  const redacted = redactSecrets(
    options.body,
    [
      process.env.CQ_FORGE_TOKEN ?? "",
      process.env.OPENAI_API_KEY ?? "",
      process.env.ANTHROPIC_API_KEY ?? "",
    ].filter((value) => value.length >= 8),
  );
  const temporary = `${path}.${createHash("sha1").update(options.runId).digest("hex").slice(0, 8)}.tmp`;
  await writeFile(temporary, `${redacted}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return path;
}
