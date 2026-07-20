#!/usr/bin/env node

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

const EXPECTED_CRITERIA = 19;
const MINIMUM_COMPLETE = 18;
const MAX_BYTES = 256 * 1024;
const path = resolve(process.argv[2] ?? "docs/PROGRESS.md");

try {
  const content = await readStableFile(path);
  const statuses = parseStatuses(content);
  const complete = statuses.filter((status) => status === "Complete").length;
  const partial = statuses.filter((status) => status === "Partial").length;
  const failed = statuses.filter((status) => status === "Failed").length;
  const percentage = Number(
    (((complete + partial * 0.5) / EXPECTED_CRITERIA) * 100).toFixed(1),
  );
  console.log(
    `acceptance: complete=${complete.toString()} partial=${partial.toString()} failed=${failed.toString()} percentage=${percentage.toFixed(1)}`,
  );
  if (complete < MINIMUM_COMPLETE || failed > 0) {
    throw new Error(
      `release requires at least ${MINIMUM_COMPLETE.toString()} complete criteria and no failed criteria`,
    );
  }
} catch (error) {
  console.error(
    `check-progress: ${error instanceof Error ? error.message : "unknown failure"}`,
  );
  process.exitCode = 1;
}

async function readStableFile(filePath) {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_BYTES)) {
      throw new Error("progress document is not a bounded regular file");
    }
    const content = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    if (
      Buffer.byteLength(content, "utf8") > MAX_BYTES ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(
        "progress document changed or exceeded limits while read",
      );
    }
    return content;
  } finally {
    await handle?.close();
  }
}

function parseStatuses(content) {
  const rows = [];
  for (const line of content.split(/\r?\n/u)) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length !== 6 || !/^\d+$/u.test(cells[1] ?? "")) continue;
    const id = Number(cells[1]);
    const status = cells[3];
    if (
      !Number.isSafeInteger(id) ||
      (status !== "Complete" && status !== "Partial" && status !== "Failed")
    ) {
      throw new Error(`criterion row ${cells[1]} has an unsupported status`);
    }
    rows.push({ id, status });
  }
  if (rows.length !== EXPECTED_CRITERIA) {
    throw new Error(
      `expected ${EXPECTED_CRITERIA.toString()} criterion rows, found ${rows.length.toString()}`,
    );
  }
  const ids = rows.map(({ id }) => id).sort((left, right) => left - right);
  if (ids.some((id, index) => id !== index + 1)) {
    throw new Error("criterion IDs must be unique and contiguous from 1 to 19");
  }
  return rows.map(({ status }) => status);
}
