import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runCli, type CliIo } from "../../src/cli.js";
import { DEFAULT_SCORE_MODEL } from "../../src/core/scoring.js";

const temporaryDirectories: string[] = [];

async function createDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

function captureIo(): {
  readonly io: CliIo;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
  };
}

function completeAssessments(): readonly Record<string, unknown>[] {
  return DEFAULT_SCORE_MODEL.majors.flatMap((major) =>
    major.minors.map((minor) => ({
      minorId: minor.id,
      status: "scored",
      rating: 5,
      confidence: "high",
      evidence: [`Verified ${minor.id}`],
      explanation: `Assessment for ${minor.id}`,
    })),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("policy, rule, readability, and score CLI integration", () => {
  test("validate combines instruction and effective-policy validation", async () => {
    const repository = await createDirectory("cq-policy-cli-");
    await createFile(repository, "AGENTS.md", "# Shared rules\n");
    await createFile(
      repository,
      "CLAUDE.md",
      "# Claude\n\nRead the sibling `AGENTS.md` in full and comply with it.\n",
    );
    await createFile(
      repository,
      ".code-quality/profile.yaml",
      'schemaVersion: "1"\nid: repository\nversion: 1\nrulePacks: [builtin:universal]\nunknownPolicy: true\n',
    );
    const capture = captureIo();

    const exitCode = await runCli(
      ["validate", repository, "--format", "json"],
      capture.io,
    );
    const output = JSON.parse(capture.stdout.join("")) as {
      readonly gate: string;
      readonly agentInstructions: { readonly gate: string };
      readonly policy: {
        readonly diagnostics: readonly { readonly code: string }[];
      };
    };

    expect(exitCode).toBe(2);
    expect(output.gate).toBe("BLOCK");
    expect(output.agentInstructions.gate).toBe("PASS");
    expect(output.policy.diagnostics).toContainEqual(
      expect.objectContaining({ code: "SCHEMA_INVALID" }),
    );
    expect(capture.stderr).toEqual([]);
  });

  test("lists and explains effective rules deterministically", async () => {
    const first = captureIo();
    const second = captureIo();

    const firstExit = await runCli(
      ["rules", "list", "--format", "json"],
      first.io,
    );
    const secondExit = await runCli(
      ["rules", "list", "--format", "json"],
      second.io,
    );
    const listed = JSON.parse(first.stdout.join("")) as {
      readonly rules: readonly { readonly id: string }[];
    };

    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);
    expect(first.stdout).toEqual(second.stdout);
    expect(listed.rules.map(({ id }) => id)).toContain("CQ-READ-003");

    const explained = captureIo();
    const explainExit = await runCli(
      ["rules", "explain", "CQ-READ-003", "--format", "json"],
      explained.io,
    );
    const detail = JSON.parse(explained.stdout.join("")) as {
      readonly rule: {
        readonly id: string;
        readonly requiredEvidence: string[];
      };
    };

    expect(explainExit).toBe(0);
    expect(detail.rule.id).toBe("CQ-READ-003");
    expect(detail.rule.requiredEvidence.length).toBeGreaterThan(0);
  });

  test("inspects readability without modifying the source file", async () => {
    const directory = await createDirectory("cq-readability-cli-");
    const source = await createFile(
      directory,
      "subject.ts",
      "export function select(value?: string) { return value ?? 'default'; }\n",
    );
    const before = await stat(source, { bigint: true });
    const beforeContent = await readFile(source, "utf8");
    const capture = captureIo();

    const exitCode = await runCli(
      ["inspect", "readability", source, "--format", "json"],
      capture.io,
    );
    const report = JSON.parse(capture.stdout.join("")) as {
      readonly gate: string;
      readonly score: {
        readonly scope: string;
        readonly domainId: string;
        readonly maximum: string;
        readonly representsRepositoryTotal: boolean;
      };
    };
    const after = await stat(source, { bigint: true });

    expect(exitCode).toBe(0);
    expect(report.gate).toBe("PASS");
    expect(report.score).toMatchObject({
      scope: "focused_domain",
      domainId: "readability",
      maximum: "20.0",
      representsRepositoryTotal: false,
    });
    expect(await readFile(source, "utf8")).toBe(beforeContent);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(capture.stderr).toEqual([]);
  });

  test("reports unsupported readability inputs as incomplete", async () => {
    const directory = await createDirectory("cq-readability-unsupported-");
    const source = await createFile(directory, "subject.py", "print('safe')\n");
    const capture = captureIo();

    const exitCode = await runCli(
      ["inspect", "readability", source, "--format", "json"],
      capture.io,
    );
    const report = JSON.parse(capture.stdout.join("")) as {
      readonly gate: string;
      readonly diagnostics: readonly { readonly code: string }[];
    };

    expect(exitCode).toBe(3);
    expect(report.gate).toBe("INCOMPLETE");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "UNSUPPORTED_LANGUAGE" }),
    );
  });

  test("reports an invalid readability path as BLOCK with exit 2", async () => {
    const directory = await createDirectory("cq-readability-missing-");
    const missing = join(directory, "missing.ts");
    const capture = captureIo();

    const exitCode = await runCli(
      ["inspect", "readability", missing, "--format", "json"],
      capture.io,
    );
    const report = JSON.parse(capture.stdout.join("")) as {
      readonly gate: string;
      readonly diagnostics: readonly { readonly code: string }[];
    };

    expect(exitCode).toBe(2);
    expect(report.gate).toBe("BLOCK");
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "INVALID_READABILITY_INPUT" }),
    );
  });

  test("maps a new function above the hard readability limit to exit 1", async () => {
    const directory = await createDirectory("cq-readability-block-");
    const statements = Array.from(
      { length: 305 },
      (_, index) => `  const value${String(index)} = ${String(index)};`,
    ).join("\n");
    const source = await createFile(
      directory,
      "giant.ts",
      `export function giant() {\n${statements}\n  return value0;\n}\n`,
    );
    const capture = captureIo();

    const exitCode = await runCli(
      ["inspect", "readability", source],
      capture.io,
    );

    expect(exitCode).toBe(1);
    expect(capture.stdout.join("")).toContain("Gate: BLOCK");
    expect(capture.stdout.join("")).toContain("CQ-READ-001");
  });

  test("escapes control characters from readability paths in terminal output", async () => {
    const directory = await createDirectory("cq-readability-terminal-");
    const source = await createFile(
      directory,
      "subject\nescape.ts",
      "export const value = 1;\n",
    );
    const capture = captureIo();

    const exitCode = await runCli(
      ["inspect", "readability", source],
      capture.io,
    );
    const output = capture.stdout.join("");

    expect(exitCode).toBe(0);
    expect(output).toContain("subject\\nescape.ts");
    expect(output).not.toContain("subject\nescape.ts");
  });

  test("summarizes many analyzed units without echoing every metric object", async () => {
    const directory = await createDirectory("cq-readability-bounded-output-");
    const source = await createFile(
      directory,
      "many-functions.ts",
      Array.from(
        { length: 1_000 },
        (_, index) =>
          `function unit${String(index)}() { return { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 }; }`,
      ).join("\n"),
    );
    const capture = captureIo();

    const exitCode = await runCli(
      ["inspect", "readability", source, "--format", "json"],
      capture.io,
    );
    const output = capture.stdout.join("");
    const report = JSON.parse(output) as {
      readonly functions?: unknown;
      readonly file?: unknown;
      readonly fileMetrics: { readonly largeObjectLiteralCount: number };
      readonly functionsAnalyzed: number;
      readonly candidates: readonly unknown[];
      readonly candidatesTotal: number;
      readonly diagnostics: readonly { readonly code: string }[];
    };

    expect(exitCode).toBe(3);
    expect(report.functionsAnalyzed).toBe(1_000);
    expect(report.functions).toBeUndefined();
    expect(report.file).toBeUndefined();
    expect(report.fileMetrics.largeObjectLiteralCount).toBe(1_000);
    expect(report.candidatesTotal).toBe(1_001);
    expect(report.candidates).toHaveLength(128);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "READABILITY_RESULT_LIMIT_EXCEEDED" }),
    );
    expect(Buffer.byteLength(output)).toBeLessThan(256 * 1024);
  });

  test("calculates a complete 100.0 score from bounded JSON input", async () => {
    const directory = await createDirectory("cq-score-cli-");
    const input = await createFile(
      directory,
      "score.json",
      JSON.stringify({
        assessments: completeAssessments(),
        context: { scope: "repository", gate: "PASS" },
      }),
    );
    const capture = captureIo();

    const exitCode = await runCli(
      ["score", input, "--format", "json"],
      capture.io,
    );
    const result = JSON.parse(capture.stdout.join("")) as {
      readonly gate: string;
      readonly representsRepositoryTotal: boolean;
      readonly display: {
        readonly normalized: string;
        readonly coverage: string;
      };
    };

    expect(exitCode).toBe(0);
    expect(result.gate).toBe("PASS");
    expect(result.representsRepositoryTotal).toBe(true);
    expect(result.display).toMatchObject({
      normalized: "100.0",
      coverage: "100.0",
    });
  });

  test("does not present a full score when a required item is not assessed", async () => {
    const directory = await createDirectory("cq-score-incomplete-");
    const assessments = [...completeAssessments()];
    const first = assessments[0];
    if (first === undefined)
      throw new Error("default score model has no minors");
    assessments[0] = {
      minorId: first.minorId,
      status: "not_assessed",
      reason: "Evidence was unavailable",
      missingEvidence: ["runtime verification"],
    };
    const input = await createFile(
      directory,
      "score.json",
      JSON.stringify({
        assessments,
        context: { scope: "repository", gate: "PASS" },
      }),
    );
    const capture = captureIo();

    const exitCode = await runCli(
      ["score", input, "--format", "json"],
      capture.io,
    );
    const result = JSON.parse(capture.stdout.join("")) as {
      readonly gate: string;
      readonly display: {
        readonly normalized: string;
        readonly coverage: string;
      };
    };

    expect(exitCode).toBe(3);
    expect(result.gate).toBe("INCOMPLETE");
    expect(result.display.normalized).toBe("N/A");
    expect(result.display.coverage).not.toBe("100.0");
  });

  test("hides the full total for a zero-weight required assessment gap", async () => {
    const directory = await createDirectory("cq-score-zero-weight-gap-");
    const defaultFirstMajor = DEFAULT_SCORE_MODEL.majors[0];
    const defaultFirstMinor = defaultFirstMajor?.minors[0];
    const defaultSecondMinor = defaultFirstMajor?.minors[1];
    if (
      defaultFirstMajor === undefined ||
      defaultFirstMinor === undefined ||
      defaultSecondMinor === undefined
    ) {
      throw new Error("default score model lacks two minors");
    }
    const model = {
      ...DEFAULT_SCORE_MODEL,
      majors: DEFAULT_SCORE_MODEL.majors.map((major, majorIndex) =>
        majorIndex === 0
          ? {
              ...major,
              minors: major.minors.map((minor, minorIndex) =>
                minorIndex === 0
                  ? { ...minor, weightTenths: 0 }
                  : minorIndex === 1
                    ? {
                        ...minor,
                        weightTenths:
                          minor.weightTenths + defaultFirstMinor.weightTenths,
                      }
                    : minor,
              ),
            }
          : major,
      ),
    };
    const assessments = [...completeAssessments()];
    assessments[0] = {
      minorId: defaultFirstMinor.id,
      status: "not_assessed",
      reason: "Evidence was unavailable",
      missingEvidence: ["required evidence"],
    };
    const input = await createFile(
      directory,
      "score.json",
      JSON.stringify({
        model: { schemaVersion: "1", ...model },
        assessments,
        context: { scope: "repository", gate: "PASS" },
      }),
    );
    const capture = captureIo();

    const exitCode = await runCli(
      ["score", input, "--format", "json"],
      capture.io,
    );
    const result = JSON.parse(capture.stdout.join("")) as {
      readonly gate: string;
      readonly representsRepositoryTotal: boolean;
      readonly display: {
        readonly normalized: string;
        readonly coverage: string;
      };
    };

    expect(exitCode).toBe(3);
    expect(result.gate).toBe("INCOMPLETE");
    expect(result.display.coverage).toBe("100.0");
    expect(result.display.normalized).toBe("N/A");
    expect(result.representsRepositoryTotal).toBe(false);
  });

  test("calculates baseline delta from a separately validated assessment", async () => {
    const directory = await createDirectory("cq-score-baseline-");
    const baselineAssessments = completeAssessments().map((assessment) => ({
      ...assessment,
      rating: 4,
    }));
    const input = await createFile(
      directory,
      "score.json",
      JSON.stringify({
        assessments: completeAssessments(),
        context: { scope: "repository", gate: "PASS" },
        baseline: {
          assessments: baselineAssessments,
          context: { scope: "repository", gate: "PASS" },
        },
      }),
    );
    const capture = captureIo();

    const exitCode = await runCli(
      ["score", input, "--format", "json"],
      capture.io,
    );
    const result = JSON.parse(capture.stdout.join("")) as {
      readonly baseline: {
        readonly comparable: boolean;
        readonly display: { readonly normalizedDelta: string };
      };
    };

    expect(exitCode).toBe(0);
    expect(result.baseline.comparable).toBe(true);
    expect(result.baseline.display.normalizedDelta).toBe("+20.0");

    const terminal = captureIo();
    const terminalExit = await runCli(["score", input], terminal.io);
    const firstMajor = DEFAULT_SCORE_MODEL.majors[0];
    const firstMinor = firstMajor?.minors[0];
    if (firstMajor === undefined || firstMinor === undefined) {
      throw new Error("default score model has no first minor");
    }
    expect(terminalExit).toBe(0);
    expect(terminal.stdout.join("")).toContain(
      `Major delta ${firstMajor.id}: +20.0`,
    );
    expect(terminal.stdout.join("")).toContain(
      `Minor delta ${firstMinor.id}: +`,
    );
  });

  test("rejects invalid score input without echoing its contents", async () => {
    const directory = await createDirectory("cq-score-invalid-");
    const sentinel = "CQ_SCORE_SECRET_SENTINEL";
    const input = await createFile(directory, "score.json", `{"${sentinel}":}`);
    const capture = captureIo();

    const exitCode = await runCli(
      ["score", input, "--format", "json"],
      capture.io,
    );
    const report = JSON.parse(capture.stdout.join("")) as {
      readonly diagnostics: readonly { readonly code: string }[];
    };

    expect(exitCode).toBe(2);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "INVALID_SCORE_INPUT" }),
    );
    expect(capture.stdout.join("")).not.toContain(sentinel);
    expect(capture.stderr.join("")).not.toContain(sentinel);
  });

  test("rejects malformed rule IDs with a structured diagnostic", async () => {
    const capture = captureIo();

    const exitCode = await runCli(
      ["rules", "explain", "not-a-rule", "--format", "json"],
      capture.io,
    );
    const report = JSON.parse(capture.stdout.join("")) as {
      readonly diagnostics: readonly { readonly code: string }[];
    };

    expect(exitCode).toBe(2);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: "RULE_NOT_FOUND" }),
    );
  });
});
