import { describe, expect, test } from "vitest";

import {
  HOOK_PRESETS,
  phaseConfigFor,
  resolveHookExitCode,
} from "../../../src/hooks/presets.js";

describe("hook presets", () => {
  test("balanced pre-commit is fast with fail-open", () => {
    expect(HOOK_PRESETS.balanced.failOpenOnIncomplete).toBe(true);
    expect(phaseConfigFor("balanced", "pre-commit").execution).toBe("fast");
    expect(phaseConfigFor("balanced", "pre-push").execution).toBe("full");
    expect(phaseConfigFor("balanced", "pre-push").input).toBe("upstream_range");
    expect(phaseConfigFor("strict", "pre-commit").execution).toBe("full");
    expect(phaseConfigFor("strict", "pre-push").input).toBe("upstream_range");
  });

  test("warn mode never blocks", () => {
    expect(
      resolveHookExitCode({
        mode: "warn",
        reviewExitCode: 1,
        failOpenOnIncomplete: true,
      }).exitCode,
    ).toBe(0);
  });

  test("block mode fail-open converts incomplete to zero", () => {
    const result = resolveHookExitCode({
      mode: "block",
      reviewExitCode: 3,
      failOpenOnIncomplete: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.note).toMatch(/fail-open/i);
  });

  test("block mode keeps gate block and config errors", () => {
    expect(
      resolveHookExitCode({
        mode: "block",
        reviewExitCode: 1,
        failOpenOnIncomplete: true,
      }).exitCode,
    ).toBe(1);
    expect(
      resolveHookExitCode({
        mode: "block",
        reviewExitCode: 2,
        failOpenOnIncomplete: true,
      }).exitCode,
    ).toBe(2);
  });
});
