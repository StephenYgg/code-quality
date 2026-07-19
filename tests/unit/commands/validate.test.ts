import { describe, expect, test } from "vitest";

import { classifyPolicyDiagnostics } from "../../../src/commands/validate.js";
import type { PolicyDiagnostic } from "../../../src/core/policy.js";

function diagnostic(code: string): PolicyDiagnostic {
  return {
    code,
    source: ".code-quality/profile.yaml",
    path: "",
    message: "bounded diagnostic",
  };
}

describe("classifyPolicyDiagnostics", () => {
  test.each([
    "WAIVER_DIRECTORY_UNSUPPORTED",
    "WAIVER_LOCATION_CHANGED",
    "CONFIG_CHANGED_DURING_READ",
    "CONFIG_RESOLUTION_TOO_LARGE",
    "DIAGNOSTIC_LIMIT_EXCEEDED",
  ])("classifies %s as incomplete instead of invalid", (code) => {
    expect(classifyPolicyDiagnostics([diagnostic(code)])).toEqual({
      gate: "INCOMPLETE",
      invalid: false,
    });
  });

  test("classifies schema failures as invalid", () => {
    expect(classifyPolicyDiagnostics([diagnostic("SCHEMA_INVALID")])).toEqual({
      gate: "BLOCK",
      invalid: true,
    });
  });

  test("does not let an incomplete diagnostic hide an invalid diagnostic", () => {
    expect(
      classifyPolicyDiagnostics([
        diagnostic("WAIVER_DIRECTORY_UNSUPPORTED"),
        diagnostic("SCHEMA_INVALID"),
      ]),
    ).toEqual({ gate: "BLOCK", invalid: true });
  });
});
