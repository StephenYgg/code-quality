import { describe, expect, test } from "vitest";

import {
  createImmutableReviewInput,
  createMetadataOnlyReviewInput,
} from "../../../src/core/review-input.js";
import { createReviewSnapshot } from "../../../src/core/snapshots.js";

function snapshot() {
  return createReviewSnapshot({
    inputKind: "worktree",
    scope: "change",
    repository: "/repo",
    head: "a".repeat(64),
    files: [
      { path: "binary.bin", status: "modified", binary: true },
      { path: "deleted.ts", status: "deleted", binary: false },
      { path: "excluded.ts", status: "modified", binary: false },
      { path: "visible.ts", status: "modified", binary: false },
    ],
    exclusions: [{ path: "excluded.ts", reason: "file_limit" }],
    incomplete: true,
  });
}

describe("immutable review input invariants", () => {
  test("accepts exactly the visible eligible content set", () => {
    const input = createImmutableReviewInput(snapshot(), [
      ["visible.ts", Buffer.from("export const visible = true;\n")],
    ]);

    expect([...input.contentByPath.keys()]).toEqual(["visible.ts"]);
  });

  test("rejects content for paths outside the snapshot", () => {
    expect(() =>
      createImmutableReviewInput(snapshot(), [
        ["visible.ts", Buffer.from("visible")],
        ["extra.ts", Buffer.from("extra")],
      ]),
    ).toThrow(/outside the snapshot/u);
  });

  test.each(["binary.bin", "deleted.ts", "excluded.ts"])(
    "rejects content for ineligible path %s",
    (path) => {
      expect(() =>
        createImmutableReviewInput(snapshot(), [
          ["visible.ts", Buffer.from("visible")],
          [path, Buffer.from("must not be captured")],
        ]),
      ).toThrow(/not eligible/u);
    },
  );

  test("rejects missing bytes for an eligible non-excluded path", () => {
    expect(() => createImmutableReviewInput(snapshot(), [])).toThrow(
      /missing.*visible\.ts/iu,
    );
  });

  test("normalizes metadata-only snapshots with explicit path exclusions", () => {
    const input = createMetadataOnlyReviewInput(snapshot());

    expect(input.contentByPath.size).toBe(0);
    expect(input.snapshot.incomplete).toBe(true);
    expect(input.snapshot.exclusions).toContainEqual({
      path: "visible.ts",
      reason: "unsupported",
    });
  });
});
