import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createImmutableReviewInput } from "../../../src/core/review-input.js";
import { createReviewSnapshot } from "../../../src/core/snapshots.js";
import { collectReviewContext } from "../../../src/review/context.js";
import { buildReviewCacheKey } from "../../../src/review/single-flight.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function snapshot(repository: string) {
  return createReviewSnapshot({
    inputKind: "worktree",
    scope: "change",
    repository,
    head: "a".repeat(64),
    files: [
      { path: "src/value.ts", status: "modified", binary: false } as const,
    ],
    exclusions: [],
    incomplete: false,
  });
}

describe("captured review context", () => {
  test("owns captured bytes behind a frozen readonly map", () => {
    const source = Buffer.from("captured\n");
    const reviewSnapshot = snapshot("/repo");
    const input = createImmutableReviewInput(reviewSnapshot, [
      ["src/value.ts", source],
    ]);
    source.fill(0);
    const firstRead = input.contentByPath.get("src/value.ts");
    firstRead?.fill(0);

    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.contentByPath)).toBe(true);
    expect(input.contentByPath.get("src/value.ts")?.toString("utf8")).toBe(
      "captured\n",
    );
    expect(input.contentBundleHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => JSON.stringify(input)).toThrow(/not serializable/i);
  });

  test("hashes content bundles independently of map insertion order", () => {
    const reviewSnapshot = createReviewSnapshot({
      ...snapshot("/repo"),
      files: [
        { path: "a.ts", status: "modified", binary: false } as const,
        { path: "b.ts", status: "modified", binary: false } as const,
      ],
    });
    const first = createImmutableReviewInput(reviewSnapshot, [
      ["b.ts", Buffer.from("b")],
      ["a.ts", Buffer.from("a")],
    ]);
    const second = createImmutableReviewInput(reviewSnapshot, [
      ["a.ts", Buffer.from("a")],
      ["b.ts", Buffer.from("b")],
    ]);

    expect(first.contentBundleHash).toBe(second.contentBundleHash);
  });

  test("never rereads a missing path from the live worktree", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-context-"));
    temporaryDirectories.push(repository);
    await writeFile(join(repository, "src-value"), "live worktree bytes\n");
    const reviewSnapshot = createReviewSnapshot({
      ...snapshot(repository),
      files: [
        { path: "src-value", status: "modified", binary: false } as const,
      ],
    });

    const context = await collectReviewContext(reviewSnapshot);

    expect(context.files).toEqual([]);
    expect(context.incomplete).toBe(true);
    expect(context.exclusions).toEqual(["src-value"]);
  });

  test("rejects invalid UTF-8 instead of sending replacement characters", async () => {
    const reviewSnapshot = snapshot("/repository/is/not/read");

    const context = await collectReviewContext(reviewSnapshot, {
      contentByPath: new Map([["src/value.ts", Buffer.from([0xc3, 0x28])]]),
    });

    expect(context.files).toEqual([]);
    expect(context.incomplete).toBe(true);
    expect(context.exclusions).toEqual(["src/value.ts"]);
  });

  test("content bundle hash participates in the single-flight cache key", () => {
    const common = {
      repositoryIdentity: "/repo",
      contentHash: "b".repeat(64),
      providerName: "provider",
      model: "model",
      policyHash: "c".repeat(64),
    };

    const first = buildReviewCacheKey({
      ...common,
      contentBundleHash: "d".repeat(64),
    });
    const second = buildReviewCacheKey({
      ...common,
      contentBundleHash: "e".repeat(64),
    });

    expect(first).not.toBe(second);
  });
});
