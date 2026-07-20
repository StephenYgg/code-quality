import { describe, expect, test } from "vitest";

import { scanRepositoryPathSet } from "../../../src/git/bounded-path-set.js";

function nullPaths(paths: readonly (string | Buffer)[]): Buffer {
  return Buffer.concat(
    paths.flatMap((path) => [
      typeof path === "string" ? Buffer.from(path) : path,
      Buffer.from([0]),
    ]),
  );
}

describe("bounded repository path sets", () => {
  test("counts all records but decodes only the tracked-first entry budget", () => {
    const result = scanRepositoryPathSet(
      {
        tracked: nullPaths(["tracked-a.ts", "tracked-b.ts"]),
        untracked: nullPaths(["untracked-a.ts", "untracked-b.ts"]),
        ignored: nullPaths([Buffer.from([0xc3, 0x28]), "ignored.txt"]),
      },
      3,
    );

    expect(result.tracked).toEqual(["tracked-a.ts", "tracked-b.ts"]);
    expect(result.untracked).toEqual(["untracked-a.ts"]);
    expect(result.ignored).toEqual([]);
    expect(result.trackedCount).toBe(2);
    expect(result.untrackedCount).toBe(2);
    expect(result.ignoredCount).toBe(2);
    expect(result.entryCount).toBe(6);
    expect(result.overflowCount).toBe(3);
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/u);
  });
});
