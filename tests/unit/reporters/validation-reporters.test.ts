import { describe, expect, test } from "vitest";

import type { AgentInstructionValidationReport } from "../../../src/instructions/reuse-validator.js";
import { renderValidationJson } from "../../../src/reporters/validation-json.js";
import { renderValidationTerminal } from "../../../src/reporters/validation-terminal.js";

const ORPHAN_DIAGNOSTIC = {
  ruleId: "CQ-AGENT-001",
  code: "ORPHAN_PEER_SCOPE",
  category: "policy",
  certainty: "deterministic",
  path: "nested/CLAUDE.md",
  message: "Peer Agent document has no same-directory AGENTS.md",
} as const;

const REPORT: AgentInstructionValidationReport = {
  ruleId: "CQ-AGENT-001",
  gate: "WARN",
  repository: "/work/example",
  scopesChecked: 1,
  filesChecked: 1,
  diagnostics: [ORPHAN_DIAGNOSTIC],
};

describe("validation reporters", () => {
  test("renders stable terminal evidence without file contents", () => {
    expect(renderValidationTerminal(REPORT)).toBe(`Gate: WARN
Rule: CQ-AGENT-001
Repository: /work/example
Scopes checked: 1
Files checked: 1
Diagnostics: 1
[WARN] ORPHAN_PEER_SCOPE nested/CLAUDE.md: Peer Agent document has no same-directory AGENTS.md
`);
  });

  test("renders parseable indented JSON with a trailing newline", () => {
    const output = renderValidationJson(REPORT);

    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output)).toEqual(REPORT);
  });

  test("labels incomplete diagnostics separately from policy warnings", () => {
    const report: AgentInstructionValidationReport = {
      ...REPORT,
      gate: "INCOMPLETE",
      diagnostics: [
        {
          ...ORPHAN_DIAGNOSTIC,
          code: "READ_FAILED",
          category: "incomplete",
        },
      ],
    };

    expect(renderValidationTerminal(report)).toContain(
      "[INCOMPLETE] READ_FAILED nested/CLAUDE.md",
    );
  });

  test("escapes control characters in terminal-visible evidence", () => {
    const report: AgentInstructionValidationReport = {
      ...REPORT,
      repository: "/work/\u001b[31mred",
      diagnostics: [
        {
          ...ORPHAN_DIAGNOSTIC,
          path: "nested/CLAUDE.md\n[PASS] forged",
          message: "unsafe\u001b[2Jmessage",
        },
      ],
    };

    const output = renderValidationTerminal(report);

    expect(output).not.toContain("\u001b");
    expect(output).toContain("\\u001b[31mred");
    expect(output).toContain("CLAUDE.md\\n[PASS] forged");
    expect(output).toContain("unsafe\\u001b[2Jmessage");
  });

  test("escapes DEL, C1, and bidirectional terminal controls", () => {
    const report: AgentInstructionValidationReport = {
      ...REPORT,
      repository: "/work/DEL\u007fC1\u009bBIDI\u202efile",
    };

    const output = renderValidationTerminal(report);

    expect(output).not.toContain("\u007f");
    expect(output).not.toContain("\u009b");
    expect(output).not.toContain("\u202e");
    expect(output).toContain("\\u007f");
    expect(output).toContain("\\u009b");
    expect(output).toContain("\\u202e");
  });

  test("renders a Markdown source location when available", () => {
    const report: AgentInstructionValidationReport = {
      ...REPORT,
      diagnostics: [
        {
          ...ORPHAN_DIAGNOSTIC,
          line: 3,
          column: 5,
        },
      ],
    };

    expect(renderValidationTerminal(report)).toContain("nested/CLAUDE.md:3:5");
  });
});
