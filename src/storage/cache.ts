import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { StoredRunRecord } from "./runs.js";
import { cacheEntriesDirectory } from "./paths.js";

export async function publishCacheEntry(
  key: string,
  record: StoredRunRecord,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(key)) {
    throw new Error("Cache key must be a sha256 hex digest");
  }
  const directory = cacheEntriesDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${key}.json`);
  const temporary = `${path}.${createHash("sha1").update(key).digest("hex").slice(0, 8)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

export async function readCacheEntry(
  key: string,
  env?: NodeJS.ProcessEnv,
): Promise<StoredRunRecord | undefined> {
  if (!/^[a-f0-9]{64}$/u.test(key)) return undefined;
  try {
    const raw = await readFile(
      join(cacheEntriesDirectory(env), `${key}.json`),
      "utf8",
    );
    return JSON.parse(raw) as StoredRunRecord;
  } catch {
    return undefined;
  }
}

export async function deleteCacheEntry(
  key: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await rm(join(cacheEntriesDirectory(env), `${key}.json`), { force: true });
}
