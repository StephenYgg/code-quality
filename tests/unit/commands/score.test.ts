import { describe, expect, test } from "vitest";

import { runScoreCommand } from "../../../src/commands/score.js";
import { BoundedFileReadError } from "../../../src/core/bounded-file.js";

describe("runScoreCommand input capture failures", () => {
  test.each(["FILE_CHANGED", "FILE_LIMIT_EXCEEDED"] as const)(
    "maps %s to INCOMPLETE and exit 3",
    async (code) => {
      let readerInvoked = false;
      const result = await runScoreCommand("score.json", "json", () => {
        readerInvoked = true;
        return Promise.reject(
          new BoundedFileReadError(code, "controlled failure"),
        );
      });

      expect(readerInvoked).toBe(true);
      expect(result.exitCode).toBe(3);
      expect(result.report).toMatchObject({
        gate: "INCOMPLETE",
        diagnostics: [{ code }],
      });
    },
  );

  test.each(["INVALID_UTF8", "READ_FAILED"] as const)(
    "maps %s to invalid input and exit 2",
    async (code) => {
      let readerInvoked = false;
      const result = await runScoreCommand("score.json", "json", () => {
        readerInvoked = true;
        return Promise.reject(
          new BoundedFileReadError(code, "controlled failure"),
        );
      });

      expect(readerInvoked).toBe(true);
      expect(result.exitCode).toBe(2);
      expect(result.report).toMatchObject({
        gate: "BLOCK",
        diagnostics: [{ code: "INVALID_SCORE_INPUT" }],
      });
    },
  );
});
