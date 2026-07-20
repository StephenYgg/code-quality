import { describe, expect, test } from "vitest";

import { createReviewSnapshot } from "../../../src/core/snapshots.js";
import { createFinding } from "../../../src/core/findings.js";
import type { ReviewRunResult } from "../../../src/review/orchestrator.js";
import { renderReviewMarkdown } from "../../../src/reporters/review-markdown.js";
import { renderReviewJson } from "../../../src/reporters/review-json.js";
import { renderReviewTerminal } from "../../../src/reporters/review-terminal.js";
import { sanitizeRunRecord } from "../../../src/storage/runs.js";

function resultWithDiagnostics(): ReviewRunResult {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    gate: "INCOMPLETE",
    findings: [],
    corroborated: [],
    uncertain: [],
    waived: [],
    diagnostics: Array.from({ length: 9 }, (_, index) => ({
      code: "PROVIDER_RESPONSE_INVALID" as const,
      stageId: `stage-${String(index)}`,
      path: `/candidates/${String(index)}`,
      message:
        index === 0
          ? `Bearer replayable-token\nforged ${"x".repeat(5_000)}`
          : `diagnostic-${String(index)}`,
    })),
    plan: {
      stages: ["universal"],
      signals: {},
      maxInFlight: 1,
      maxAttempts: 2,
      execution: "fast",
    },
    snapshot: createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [],
      exclusions: [],
      incomplete: false,
    }),
    incomplete: true,
    providerAttempts: 2,
    promptBundleVersion: "cq-prompt-bundle/v2",
    reportHash: "b".repeat(64),
    contentBundleHash: "c".repeat(64),
    assessments: [],
    scoreGate: "INCOMPLETE",
    contextIncomplete: false,
  };
}

describe("review diagnostics reporters", () => {
  test.each([
    ["terminal", renderReviewTerminal],
    ["markdown", renderReviewMarkdown],
  ] as const)("renders bounded redacted diagnostics in %s", (_name, render) => {
    const output = render(resultWithDiagnostics());

    expect(output).toContain("Diagnostics");
    expect(output).toContain("PROVIDER_RESPONSE_INVALID");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("replayable-token");
    expect(output).not.toContain("\nforged ");
    expect(output).not.toContain("diagnostic-8");
    expect(output.length).toBeLessThan(10_000);
  });

  test("neutralizes multiline Markdown, HTML, links, and mentions from provider fields", () => {
    const result = resultWithDiagnostics();
    const malicious = createFinding({
      id: "finding-1`\n## forged",
      title:
        "Safe title\n## Forged <script>alert(1)</script> @team [click](https://evil.invalid)",
      severity: "P2",
      disposition: "new",
      confidence: "medium",
      stages: ["behavior"],
      evidence:
        "evidence\n\n## Injected [credential](https://evil.invalid) <img src=x> @all",
      impact: "impact\n> forged quote",
      remediation: "fix with `code` and <a href=x>link</a> @owner",
      lifecycle: "confirmed",
    });

    const output = renderReviewMarkdown({
      ...result,
      findings: [malicious],
    });

    expect(output).not.toContain("\n## Forged");
    expect(output).not.toContain("\n## Injected");
    expect(output).not.toContain("<script>");
    expect(output).not.toContain("<img");
    expect(output).not.toContain("[click](https://evil.invalid)");
    expect(output).not.toContain("@team");
    expect(output).not.toContain("@all");
    expect(output).toContain("&lt;script&gt;");
    expect(output).toContain("&#64;team");
  });

  test.each([
    ["terminal", renderReviewTerminal],
    ["markdown", renderReviewMarkdown],
  ] as const)(
    "renders every stored finding bucket and diagnostics in %s",
    (_name, render) => {
      const base = createFinding({
        id: "confirmed-1",
        title: "Confirmed title",
        severity: "P2",
        disposition: "new",
        confidence: "high",
        stages: ["behavior"],
        evidence: "confirmed evidence",
        impact: "confirmed impact",
        remediation: "confirmed remediation",
        lifecycle: "confirmed",
      });
      const live: ReviewRunResult = {
        ...resultWithDiagnostics(),
        findings: [base],
        corroborated: [
          {
            ...base,
            id: "corroborated-1",
            title: "Corroborated title",
            lifecycle: "corroborated",
            blockingVerificationUnresolved: true,
          },
        ],
        uncertain: [
          {
            ...base,
            id: "uncertain-1",
            title: "Uncertain title",
            lifecycle: "uncertain",
          },
        ],
        waived: [
          {
            ...base,
            id: "waived-1",
            title: "Waived title",
            lifecycle: "waived",
          },
        ],
        diagnostics: [
          {
            code: "PROVIDER_RESPONSE_INVALID",
            stageId: "behavior",
            path: "/candidates/0",
            message: "Stored diagnostic",
          },
        ],
      };
      const record = sanitizeRunRecord(live, {
        policyHash: "d".repeat(64),
        providerName: "codex",
        providerKind: "codex_cli",
        model: "gpt-test",
        adapterVersion: "cq-provider-adapter/v1",
        startedAt: "2026-07-20T00:00:00.000Z",
      });

      const output = render(record);

      expect(output).toContain("Confirmed title");
      expect(output).toContain("Corroborated");
      expect(output).toContain("Corroborated title");
      expect(output).toContain("Uncertain title");
      expect(output).toContain("Waived");
      expect(output).toContain("Waived title");
      expect(output).toContain("Diagnostics");
      expect(output).toContain("Stored diagnostic");
    },
  );

  test("renders stored records losslessly as JSON", () => {
    const record = sanitizeRunRecord(resultWithDiagnostics(), {
      policyHash: "d".repeat(64),
      providerName: "codex",
      providerKind: "codex_cli",
      model: "gpt-test",
      adapterVersion: "cq-provider-adapter/v1",
      startedAt: "2026-07-20T00:00:00.000Z",
    });

    const rendered: unknown = JSON.parse(renderReviewJson(record));
    expect(rendered).toEqual(record);
    expect(record.diagnostics).toHaveLength(9);
  });
});
