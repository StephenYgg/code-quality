import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { runCli } from "../../src/cli.js";
import {
  runReviewCommand,
  type ReviewCommandResult,
} from "../../src/commands/review.js";
import {
  DEFAULT_SCORE_MODEL,
  type ScoreModel,
} from "../../src/core/scoring.js";
import type {
  ProviderDiagnostic,
  ProviderReviewRequest,
  ProviderReviewResponse,
  ReviewProvider,
} from "../../src/providers/provider.js";
import type { LocalGitInputIo } from "../../src/git/inputs.js";
import type { BlockingEvidenceVerifier } from "../../src/review/verifier.js";
import { DEFAULT_CACHE_LIMITS } from "../../src/storage/cache.js";
import {
  MAX_RUN_CLEANUP_PER_WRITE,
  MAX_STORED_RUNS,
} from "../../src/storage/runs.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

class FakeProvider implements ReviewProvider {
  requests = 0;
  validations = 0;

  capabilities() {
    return {
      kind: "codex_cli" as const,
      transport: "process" as const,
      structuredOutput: "prompt_json" as const,
      isolation: "no_tools" as const,
      usage: "unavailable" as const,
      finishReason: "derived" as const,
      requestId: "execution_id" as const,
      cancellation: true as const,
    };
  }
  validateConfiguration(): Promise<readonly ProviderDiagnostic[]> {
    this.validations += 1;
    return Promise.resolve([]);
  }
  review(request: ProviderReviewRequest): Promise<ProviderReviewResponse> {
    void request;
    this.requests += 1;
    return Promise.resolve({
      content: { candidates: [] },
      usage: null,
      finishReason: "stop",
      rawFinishReason: null,
      providerRequestId: "fake",
      truncated: false,
      attemptsUsed: 1,
    });
  }
  redactDiagnostic(value: unknown): string {
    return String(value);
  }
}

class P2FakeProvider extends FakeProvider {
  override review(
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse> {
    this.requests += 1;
    return Promise.resolve({
      content: {
        candidates: [
          {
            title: "Confirmed repository maintainability regression",
            severity: "P2",
            evidence:
              "The captured source contains the confirmed regression marker.",
            path: "a.ts",
            startLine: 1,
            endLine: 1,
            sourceQuote: "export const a = 1;",
            impact: "The changed repository cannot pass its configured gate.",
            remediation: "Remove the confirmed regression before review.",
          },
        ],
      },
      usage: null,
      finishReason: "stop",
      rawFinishReason: null,
      providerRequestId: `p2-${request.stageId}`,
      truncated: false,
      attemptsUsed: 1,
    });
  }
}

class BlockingFakeProvider extends FakeProvider {
  readonly started: Promise<void>;
  private readonly finish: Promise<void>;
  private markStarted!: () => void;
  private finishReviews!: () => void;

  constructor() {
    super();
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
    this.finish = new Promise<void>((resolve) => {
      this.finishReviews = resolve;
    });
  }

  release(): void {
    this.finishReviews();
  }

  override async review(
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse> {
    void request;
    this.requests += 1;
    this.markStarted();
    await this.finish;
    return {
      content: { candidates: [] },
      usage: null,
      finishReason: "stop",
      rawFinishReason: null,
      providerRequestId: "blocking-fake",
      truncated: false,
      attemptsUsed: 1,
    };
  }
}

class ScoringFakeProvider extends FakeProvider {
  requests = 0;
  readonly seenMinorIds: string[] = [];

  constructor(
    protected readonly evidencePath = "a.ts",
    protected readonly sourceQuote = "export const a = 2;",
  ) {
    super();
  }

  override review(
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse> {
    this.requests += 1;
    const minorIds = [
      ...request.systemInstructions.matchAll(/^Allowed minor: ([^ ]+) \|/gmu),
    ].map((match) => {
      const minorId = match[1];
      if (minorId === undefined)
        throw new Error("allowed minor capture missing");
      return minorId;
    });
    this.seenMinorIds.push(...minorIds);
    return Promise.resolve({
      content: {
        candidates: [],
        assessments: minorIds.map((minorId) => ({
          minorId,
          status: "scored",
          rating: 5,
          confidence: "high",
          evidence: [
            {
              path: this.evidencePath,
              startLine: 1,
              endLine: 1,
              sourceQuote: this.sourceQuote,
            },
          ],
          explanation: "The rating is grounded in the captured source line.",
        })),
      },
      usage: null,
      finishReason: "stop",
      rawFinishReason: null,
      providerRequestId: "scoring-fake",
      truncated: false,
      attemptsUsed: 1,
    });
  }
}

class BlockingScoringFakeProvider extends ScoringFakeProvider {
  override async review(
    request: ProviderReviewRequest,
  ): Promise<ProviderReviewResponse> {
    const response = await super.review(request);
    const content = response.content as {
      readonly assessments: readonly unknown[];
    };
    return {
      ...response,
      content: {
        candidates: [
          {
            title: "Confirmed authorization bypass",
            severity: "P1",
            evidence:
              "The captured resource path bypasses a required authorization decision.",
            path: this.evidencePath,
            startLine: 1,
            endLine: 1,
            sourceQuote: this.sourceQuote,
            impact: "A caller may cross an authorization boundary.",
            remediation: "Enforce authorization before resource access.",
          },
        ],
        assessments: content.assessments,
      },
    };
  }
}

function reweightedScoreModel(): ScoreModel {
  const majorWeights: Readonly<Record<string, number>> = {
    correctness: 190,
    readability: 210,
  };
  const minorWeights: Readonly<Record<string, number>> = {
    "intent-contract": 30,
    "primary-path": 40,
    "boundaries-invalid-input": 40,
    "failure-timeout-retry-cancellation": 40,
    "state-side-effects-idempotency": 40,
    "naming-intent-domain-language": 40,
    "function-responsibility-size": 40,
    "control-flow-visible-stages": 40,
    "conditional-fallback-clarity": 30,
    "try-catch-error-boundaries": 30,
    "state-return-types-result-shapes": 30,
  };
  return {
    ...DEFAULT_SCORE_MODEL,
    ruleVersions: { ...DEFAULT_SCORE_MODEL.ruleVersions },
    majors: DEFAULT_SCORE_MODEL.majors.map((major) => ({
      ...major,
      weightTenths: majorWeights[major.id] ?? major.weightTenths,
      minors: major.minors.map((minor) => ({
        ...minor,
        weightTenths: minorWeights[minor.id] ?? minor.weightTenths,
        domainVocabulary: [...minor.domainVocabulary],
        ratingAnchors: { ...minor.ratingAnchors },
      })),
    })),
  };
}

async function git(repository: string, args: readonly string[]): Promise<void> {
  await executeFile(
    "git",
    [
      "--no-pager",
      "-c",
      "user.name=Code Quality Test",
      "-c",
      "user.email=code-quality@example.invalid",
      ...args,
    ],
    {
      cwd: repository,
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        PATH: process.env.PATH ?? "",
      },
    },
  );
}

async function lockRoots(state: string): Promise<number> {
  try {
    return (await readdir(join(state, "locks"))).filter((name) =>
      name.endsWith(".lock"),
    ).length;
  } catch {
    return 0;
  }
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  waitMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for review command condition");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("review CLI surface", () => {
  test("maps local source staleness to an incomplete result", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-stale-"));
    temporaryDirectories.push(repository);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.ts"), "export const a = 2;\n");
    const localGitIo: LocalGitInputIo = {
      beforeSourceVerification: async () => {
        await writeFile(join(repository, "a.ts"), "export const a = 3;\n");
      },
    };

    const previous = process.cwd();
    process.chdir(repository);
    try {
      const result = await runReviewCommand({
        worktree: true,
        provider: new FakeProvider(),
        localGitIo,
      });

      expect(result.exitCode).toBe(3);
      expect(result.output).toContain("Gate: INCOMPLETE");
      expect(result.output).toContain("Git input changed");
    } finally {
      process.chdir(previous);
    }
  });

  test("maps invalid local revisions to a usage error", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-invalid-"));
    temporaryDirectories.push(repository);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const previous = process.cwd();
    process.chdir(repository);
    try {
      const result = await runReviewCommand({
        commit: "missing-revision",
        provider: new FakeProvider(),
      });

      expect(result.exitCode).toBe(2);
      expect(result.output).not.toContain("Gate: INCOMPLETE");
    } finally {
      process.chdir(previous);
    }
  });

  test("previews quality commands from the bound repository profile", async () => {
    const repository = await mkdtemp(
      join(tmpdir(), "cq-review-check-profile-"),
    );
    temporaryDirectories.push(repository);
    await git(repository, ["init", "--quiet"]);
    await mkdir(join(repository, ".code-quality"));
    await writeFile(
      join(repository, ".code-quality", "profile.yaml"),
      [
        'schemaVersion: "1"',
        "id: command-profile",
        "version: 1",
        "rulePacks: [builtin:universal]",
        "qualityCommands:",
        "  - label: profile-check",
        `    argv: [${JSON.stringify(process.execPath)}, "--version"]`,
        "    timeoutMs: 1000",
        "    maxStdoutBytes: 4096",
        "    maxStderrBytes: 4096",
        "",
      ].join("\n"),
    );
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.ts"), "export const a = 2;\n");
    await git(repository, ["add", "--all", "--"]);
    const provider = new FakeProvider();

    const previous = process.cwd();
    process.chdir(repository);
    try {
      const result = await runReviewCommand({
        staged: true,
        provider,
        runChecks: true,
        runChecksPreviewOnly: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("profile-check");
      expect(result.output).not.toContain("typecheck");
      expect(provider.requests).toBe(0);
    } finally {
      process.chdir(previous);
    }
  });

  test("runs staged checks against captured staged bytes, not unstaged bytes", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-check-staged-"));
    const state = await mkdtemp(join(tmpdir(), "cq-review-check-state-"));
    temporaryDirectories.push(repository, state);
    await git(repository, ["init", "--quiet"]);
    await mkdir(join(repository, ".code-quality"));
    const script =
      "const fs=require('node:fs');process.exit(fs.readFileSync('a.txt','utf8')==='staged\\n'?0:9)";
    await writeFile(
      join(repository, ".code-quality", "profile.yaml"),
      [
        'schemaVersion: "1"',
        "id: staged-command-profile",
        "version: 1",
        "rulePacks: [builtin:universal]",
        "qualityCommands:",
        "  - label: staged-bytes",
        `    argv: [${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(script)}]`,
        "    timeoutMs: 1000",
        "    maxStdoutBytes: 4096",
        "    maxStderrBytes: 4096",
        "",
      ].join("\n"),
    );
    await writeFile(join(repository, "a.txt"), "old\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.txt"), "staged\n");
    await git(repository, ["add", "a.txt", "--"]);
    await writeFile(join(repository, "a.txt"), "unstaged\n");
    const provider = new FakeProvider();
    const previousState = process.env.CQ_STATE_DIR;
    const previous = process.cwd();
    process.env.CQ_STATE_DIR = state;
    process.chdir(repository);
    try {
      const result = await runReviewCommand({
        staged: true,
        provider,
        runChecks: true,
        disableSingleFlight: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("INCOMPLETE");
    } finally {
      process.chdir(previous);
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
    }
  });

  test("repository preflight without a provider is explicitly non-confirmable", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-cli-"));
    temporaryDirectories.push(repository);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const previous = process.cwd();
    process.chdir(repository);
    try {
      const result = await runReviewCommand({
        repository: ".",
        preflight: true,
        format: "json",
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({ confirmable: false });
      expect(result.output).not.toContain("confirmationHash");
    } finally {
      process.chdir(previous);
    }
  });

  test("rejects unsupported repository run-checks before issuing a confirmation hash", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-checks-"));
    temporaryDirectories.push(repository);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const provider = new FakeProvider();

    const result = await runReviewCommand({
      repository,
      preflight: true,
      provider,
      runChecks: true,
      format: "json",
    });

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/run-checks.*not supported/iu);
    expect(result.output).not.toContain("confirmationHash");
    expect(provider.validations).toBe(0);
    expect(provider.requests).toBe(0);
  });

  test("reuses a confirmable repository preflight without calling the provider during preflight", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-repository-"));
    const state = await mkdtemp(join(tmpdir(), "cq-review-repository-state-"));
    temporaryDirectories.push(repository, state);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const provider = new FakeProvider();
    const previousState = process.env.CQ_STATE_DIR;
    process.env.CQ_STATE_DIR = state;
    try {
      const preflight = await runReviewCommand({
        repository,
        preflight: true,
        provider,
        model: "test-model",
        format: "json",
      });
      const document = JSON.parse(preflight.output) as {
        readonly confirmable: boolean;
        readonly confirmationHash: string;
        readonly executionDescriptorHash: string;
      };

      expect(preflight.exitCode).toBe(0);
      expect(document.confirmable).toBe(true);
      expect(document.confirmationHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(document.executionDescriptorHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(provider.requests).toBe(0);
      expect(provider.validations).toBe(0);

      const executed = await runReviewCommand({
        repository,
        confirmFullRepository: document.confirmationHash,
        provider,
        model: "test-model",
        disableSingleFlight: true,
      });

      expect(executed.exitCode).toBe(0);
      expect(provider.requests).toBeGreaterThan(0);
    } finally {
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
    }
  });

  test("rejects repository descriptor drift before calling the provider", async () => {
    const repository = await mkdtemp(
      join(tmpdir(), "cq-review-repository-drift-"),
    );
    temporaryDirectories.push(repository);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const provider = new FakeProvider();
    const preflight = await runReviewCommand({
      repository,
      preflight: true,
      provider,
      model: "model-a",
      format: "json",
    });
    const confirmationHash = (
      JSON.parse(preflight.output) as {
        readonly confirmationHash: string;
      }
    ).confirmationHash;

    const executed = await runReviewCommand({
      repository,
      confirmFullRepository: confirmationHash,
      provider,
      model: "model-b",
    });

    expect(executed.exitCode).not.toBe(0);
    expect(executed.output).toMatch(/confirmation|descriptor/iu);
    expect(provider.requests).toBe(0);
  });

  test("fails closed on invalid repository policy before preflight provider use", async () => {
    const repository = await mkdtemp(
      join(tmpdir(), "cq-review-policy-invalid-"),
    );
    temporaryDirectories.push(repository);
    await mkdir(join(repository, ".code-quality"));
    await writeFile(
      join(repository, ".code-quality", "profile.yaml"),
      'schemaVersion: "1"\nid: invalid\nversion: 1\nrulePacks: [missing]\n',
    );
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const provider = new FakeProvider();

    const result = await runReviewCommand({
      repository,
      preflight: true,
      provider,
      format: "json",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("confirmationHash");
    expect(provider.requests).toBe(0);
    expect(provider.validations).toBe(0);
  });

  test("applies the repository P2 blocking threshold during confirmed execution", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-p2-gate-"));
    const state = await mkdtemp(join(tmpdir(), "cq-review-p2-state-"));
    temporaryDirectories.push(repository, state);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const provider = new P2FakeProvider();
    const previousState = process.env.CQ_STATE_DIR;
    process.env.CQ_STATE_DIR = state;
    try {
      const preflight = await runReviewCommand({
        repository,
        preflight: true,
        provider,
        format: "json",
      });
      const confirmationHash = (
        JSON.parse(preflight.output) as {
          readonly confirmationHash: string;
        }
      ).confirmationHash;
      const result = await runReviewCommand({
        repository,
        confirmFullRepository: confirmationHash,
        provider,
        blockingEvidenceVerifier: {
          verify: ({ candidate }) => ({
            kind: "deterministic",
            statement:
              "The configured repository gate was independently verified.",
            path: candidate.path ?? "",
            startLine: candidate.startLine ?? 0,
            endLine: candidate.endLine ?? 0,
          }),
        },
        disableSingleFlight: true,
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Gate: BLOCK");
      expect(result.output).toContain("P2");
    } finally {
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
    }
  });

  test("ordinary and scored staged reviews use separate cache entries", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-cli-"));
    const state = await mkdtemp(join(tmpdir(), "cq-state-"));
    temporaryDirectories.push(repository, state);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.ts"), "export const a = 2;\n");
    await git(repository, ["add", "--all", "--"]);

    const previous = process.cwd();
    const previousState = process.env.CQ_STATE_DIR;
    process.chdir(repository);
    process.env.CQ_STATE_DIR = state;
    try {
      const result = await runReviewCommand({
        staged: true,
        provider: new FakeProvider(),
        format: "terminal",
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Gate:");
      expect(result.output).not.toContain("ScoreGate:");
      expect(result.output).not.toContain("Full score model:");

      const scored = await runReviewCommand({
        staged: true,
        provider: new FakeProvider(),
        format: "terminal",
        score: true,
      });
      expect(scored.exitCode).toBe(3);
      expect(scored.output).toContain("ScoreGate: INCOMPLETE");
      expect(scored.output).toContain("Full score model:");
      expect(scored.output).not.toContain("Cache: hit");
    } finally {
      process.chdir(previous);
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
    }
  });

  test("non-auth score mode never prompts security minors and exits incomplete", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-unrouted-"));
    const state = await mkdtemp(join(tmpdir(), "cq-unrouted-state-"));
    temporaryDirectories.push(repository, state);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.ts"), "export const a = 2;\n");
    await git(repository, ["add", "--all", "--"]);
    const provider = new ScoringFakeProvider();

    const previous = process.cwd();
    const previousState = process.env.CQ_STATE_DIR;
    process.chdir(repository);
    process.env.CQ_STATE_DIR = state;
    try {
      const result = await runReviewCommand({
        staged: true,
        provider,
        format: "terminal",
        score: true,
        disableSingleFlight: true,
      });
      const securityIds =
        DEFAULT_SCORE_MODEL.majors
          .find((major) => major.id === "security")
          ?.minors.map((minor) => minor.id) ?? [];

      expect(provider.seenMinorIds).not.toEqual(
        expect.arrayContaining(securityIds),
      );
      expect(result.exitCode).toBe(3);
      expect(result.output).toContain("ScoreGate: INCOMPLETE");
      expect(result.output).toContain("Score: N/A/100.0 coverage=88.0%");
    } finally {
      process.chdir(previous);
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
    }
  });

  test("score evidence completeness takes exit precedence while Behavior Gate remains BLOCK", async () => {
    const verifier: BlockingEvidenceVerifier = {
      verify: ({ candidate }) => ({
        kind: "deterministic",
        statement: "Independent control-flow verification confirmed the bypass",
        path: candidate.path ?? "",
        startLine: candidate.startLine ?? 0,
        endLine: candidate.endLine ?? 0,
      }),
    };
    const execute = async (options: {
      readonly name: string;
      readonly path: string;
      readonly before: string;
      readonly after: string;
    }) => {
      const repository = await mkdtemp(
        join(tmpdir(), `cq-review-block-${options.name}-`),
      );
      const state = await mkdtemp(
        join(tmpdir(), `cq-review-block-state-${options.name}-`),
      );
      temporaryDirectories.push(repository, state);
      await git(repository, ["init", "--quiet"]);
      await writeFile(join(repository, options.path), `${options.before}\n`);
      await git(repository, ["add", "--all", "--"]);
      await git(repository, ["commit", "--quiet", "-m", "initial"]);
      await writeFile(join(repository, options.path), `${options.after}\n`);
      await git(repository, ["add", "--all", "--"]);

      const previous = process.cwd();
      const previousState = process.env.CQ_STATE_DIR;
      process.chdir(repository);
      process.env.CQ_STATE_DIR = state;
      try {
        return await runReviewCommand({
          staged: true,
          provider: new BlockingScoringFakeProvider(
            options.path,
            options.after,
          ),
          blockingEvidenceVerifier: verifier,
          format: "terminal",
          score: true,
          disableSingleFlight: true,
        });
      } finally {
        process.chdir(previous);
        if (previousState === undefined) delete process.env.CQ_STATE_DIR;
        else process.env.CQ_STATE_DIR = previousState;
      }
    };

    const incomplete = await execute({
      name: "incomplete",
      path: "a.ts",
      before: "export const a = 1;",
      after: "export const a = 2;",
    });
    const complete = await execute({
      name: "complete",
      path: "auth.ts",
      before: "export const authorized = false;",
      after: "export const authorized = true;",
    });

    expect(incomplete.exitCode).toBe(3);
    expect(incomplete.output).toContain("Gate: BLOCK");
    expect(incomplete.output).toContain("ScoreGate: INCOMPLETE");
    expect(incomplete.output).toContain("Score: N/A/100.0");
    expect(complete.exitCode).toBe(1);
    expect(complete.output).toContain("Gate: BLOCK");
    expect(complete.output).toContain("ScoreGate: BLOCK");
    expect(complete.output).not.toContain("Score: N/A/100.0");
  });

  test("score cache hit restores the complete score from cached assessments", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-score-cache-"));
    const state = await mkdtemp(join(tmpdir(), "cq-score-cache-state-"));
    temporaryDirectories.push(repository, state);
    await git(repository, ["init", "--quiet"]);
    await writeFile(
      join(repository, "auth.ts"),
      "export const authorized = false;\n",
    );
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(
      join(repository, "auth.ts"),
      "export const authorized = true;\n",
    );
    await git(repository, ["add", "--all", "--"]);

    const previous = process.cwd();
    const previousState = process.env.CQ_STATE_DIR;
    const provider = new ScoringFakeProvider(
      "auth.ts",
      "export const authorized = true;",
    );
    process.chdir(repository);
    process.env.CQ_STATE_DIR = state;
    try {
      const first = await runReviewCommand({
        staged: true,
        provider,
        format: "terminal",
        score: true,
      });
      const requestCount = provider.requests;
      const second = await runReviewCommand({
        staged: true,
        provider,
        format: "terminal",
        score: true,
      });

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(first.output).toContain(
        "Score: 100.0/100.0 coverage=100.0% model=cq-default@1.0.0",
      );
      expect(second.output).toContain(
        "Score: 100.0/100.0 coverage=100.0% model=cq-default@1.0.0",
      );
      expect(second.output).toContain("Cache: hit");
      expect(second.output).toContain("Assessments: 37");
      expect(provider.requests).toBe(requestCount);
    } finally {
      process.chdir(previous);
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
    }
  });

  test("score cache identity binds full model semantics instead of readable metadata", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-model-cache-"));
    const state = await mkdtemp(join(tmpdir(), "cq-model-cache-state-"));
    temporaryDirectories.push(repository, state);
    await git(repository, ["init", "--quiet"]);
    await writeFile(
      join(repository, "auth.ts"),
      "export const authorized = false;\n",
    );
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(
      join(repository, "auth.ts"),
      "export const authorized = true;\n",
    );
    await git(repository, ["add", "--all", "--"]);
    const provider = new ScoringFakeProvider(
      "auth.ts",
      "export const authorized = true;",
    );
    const reweighted = reweightedScoreModel();
    const reordered: ScoreModel = {
      majors: reweighted.majors,
      roundingMode: reweighted.roundingMode,
      ruleVersions: { ...reweighted.ruleVersions },
      version: reweighted.version,
      id: reweighted.id,
    };

    const previous = process.cwd();
    const previousState = process.env.CQ_STATE_DIR;
    process.chdir(repository);
    process.env.CQ_STATE_DIR = state;
    try {
      const first = await runReviewCommand({
        staged: true,
        provider,
        format: "terminal",
        score: true,
        scoreModel: DEFAULT_SCORE_MODEL,
      });
      const afterFirst = provider.requests;
      const second = await runReviewCommand({
        staged: true,
        provider,
        format: "terminal",
        score: true,
        scoreModel: reweighted,
      });
      const afterSecond = provider.requests;
      const third = await runReviewCommand({
        staged: true,
        provider,
        format: "terminal",
        score: true,
        scoreModel: reordered,
      });

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(second.output).not.toContain("Cache: hit");
      expect(afterSecond).toBeGreaterThan(afterFirst);
      expect(second.output).toContain(
        "Behavioral correctness: 100.0/19.0 (100.0% coverage)",
      );
      expect(third.exitCode).toBe(0);
      expect(third.output).toContain("Cache: hit");
      expect(provider.requests).toBe(afterSecond);
    } finally {
      process.chdir(previous);
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
    }
  });

  test("score mode applies repository profile weights to the executable model", async () => {
    const repository = await mkdtemp(
      join(tmpdir(), "cq-review-score-profile-"),
    );
    const state = await mkdtemp(join(tmpdir(), "cq-score-profile-state-"));
    temporaryDirectories.push(repository, state);
    await mkdir(join(repository, ".code-quality"));
    await writeFile(
      join(repository, ".code-quality", "profile.yaml"),
      [
        'schemaVersion: "1"',
        "id: repository",
        "version: 1",
        "rulePacks: [builtin:universal]",
        "scoreModel:",
        "  id: cq-default-100",
        "  majorWeights: { correctness: 19.0, readability: 21.0 }",
        "  minorWeights:",
        "    intent-contract: 3.0",
        "    primary-path: 4.0",
        "    boundaries-invalid-input: 4.0",
        "    failure-timeout-retry-cancellation: 4.0",
        "    state-side-effects-idempotency: 4.0",
        "    naming-intent-domain-language: 4.0",
        "    function-responsibility-size: 4.0",
        "    control-flow-visible-stages: 4.0",
        "    conditional-fallback-clarity: 3.0",
        "    try-catch-error-boundaries: 3.0",
        "    state-return-types-result-shapes: 3.0",
        "",
      ].join("\n"),
    );
    await git(repository, ["init", "--quiet"]);
    await writeFile(
      join(repository, "auth.ts"),
      "export const authorized = false;\n",
    );
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(
      join(repository, "auth.ts"),
      "export const authorized = true;\n",
    );
    await git(repository, ["add", "--all", "--"]);

    const previous = process.cwd();
    const previousState = process.env.CQ_STATE_DIR;
    process.chdir(repository);
    process.env.CQ_STATE_DIR = state;
    try {
      const result = await runReviewCommand({
        staged: true,
        provider: new ScoringFakeProvider(
          "auth.ts",
          "export const authorized = true;",
        ),
        format: "terminal",
        score: true,
        disableSingleFlight: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toMatch(
        /model=cq-default@1\.0\.0\+profile\.[a-f0-9]{12}/u,
      );
      expect(result.output).toContain(
        "Behavioral correctness: 100.0/19.0 (100.0% coverage)",
      );
    } finally {
      process.chdir(previous);
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
    }
  });

  test("unknown repository score model fails policy binding", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-score-policy-"));
    temporaryDirectories.push(repository);
    await mkdir(join(repository, ".code-quality"));
    await writeFile(
      join(repository, ".code-quality", "profile.yaml"),
      'schemaVersion: "1"\nid: repository\nversion: 1\nrulePacks: [builtin:universal]\nscoreModel:\n  id: custom-model\n',
    );
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.ts"), "export const a = 2;\n");
    await git(repository, ["add", "--all", "--"]);

    const previous = process.cwd();
    process.chdir(repository);
    try {
      const result = await runReviewCommand({
        staged: true,
        provider: new ScoringFakeProvider(),
        format: "terminal",
        score: true,
      });

      expect(result.exitCode).toBe(2);
      expect(result.output).toContain("Unknown score model ID: custom-model");
    } finally {
      process.chdir(previous);
    }
  });

  test("returns incomplete when a review result cannot be persisted", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-storage-"));
    const state = await mkdtemp(join(tmpdir(), "cq-state-storage-"));
    temporaryDirectories.push(repository, state);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.ts"), "export const a = 2;\n");
    await git(repository, ["add", "--all", "--"]);
    const runs = join(state, "runs");
    await mkdir(runs, { mode: 0o700 });
    const blockingFiles = MAX_STORED_RUNS + MAX_RUN_CLEANUP_PER_WRITE + 1;
    for (let index = 0; index < blockingFiles; index += 1) {
      await writeFile(join(runs, `unknown-${index.toString()}`), "blocked\n", {
        mode: 0o600,
      });
    }

    const previous = process.cwd();
    const previousState = process.env.CQ_STATE_DIR;
    process.chdir(repository);
    process.env.CQ_STATE_DIR = state;
    try {
      const result = await runReviewCommand({
        staged: true,
        provider: new FakeProvider(),
        format: "terminal",
        disableSingleFlight: true,
      });

      expect(result.exitCode).toBe(3);
      expect(result.output).toContain("Gate: INCOMPLETE");
      expect(result.output).toContain("RUN_STORAGE_CAPACITY_EXCEEDED");
      expect(result.output).toContain("was not persisted");
      expect(result.output).toContain("cannot be retrieved with cq report");
      expect(result.output).not.toContain("ScoreGate:");
    } finally {
      process.chdir(previous);
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
    }
  });

  test("never exposes a cache hit when durable run persistence fails", async () => {
    const repository = await mkdtemp(
      join(tmpdir(), "cq-review-durable-cache-"),
    );
    const state = await mkdtemp(join(tmpdir(), "cq-state-durable-cache-"));
    temporaryDirectories.push(repository, state);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.ts"), "export const a = 2;\n");
    await git(repository, ["add", "--all", "--"]);
    const runs = join(state, "runs");
    await mkdir(runs, { mode: 0o700 });
    const blockingFiles = MAX_STORED_RUNS + MAX_RUN_CLEANUP_PER_WRITE + 1;
    for (let index = 0; index < blockingFiles; index += 1) {
      await writeFile(join(runs, `unknown-${index.toString()}`), "blocked\n", {
        mode: 0o600,
      });
    }
    const provider = new FakeProvider();

    const previous = process.cwd();
    const previousState = process.env.CQ_STATE_DIR;
    const previousCache = process.env.CQ_CACHE_DIR;
    process.chdir(repository);
    process.env.CQ_STATE_DIR = state;
    process.env.CQ_CACHE_DIR = state;
    try {
      const first = await runReviewCommand({
        staged: true,
        provider,
        format: "terminal",
      });
      const firstRequestCount = provider.requests;
      const second = await runReviewCommand({
        staged: true,
        provider,
        format: "terminal",
      });

      expect(first.exitCode).toBe(3);
      expect(second.exitCode).toBe(3);
      expect(first.output).toContain("RUN_STORAGE_CAPACITY_EXCEEDED");
      expect(second.output).toContain("RUN_STORAGE_CAPACITY_EXCEEDED");
      expect(first.output).not.toContain("Cache: hit");
      expect(second.output).not.toContain("Cache: hit");
      expect(firstRequestCount).toBeGreaterThan(0);
      expect(provider.requests).toBe(firstRequestCount * 2);
      await expect(readdir(join(state, "entries"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      process.chdir(previous);
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
      if (previousCache === undefined) delete process.env.CQ_CACHE_DIR;
      else process.env.CQ_CACHE_DIR = previousCache;
    }
  });

  test("returns incomplete after durable storage when cache capacity is exhausted", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-cache-full-"));
    const state = await mkdtemp(join(tmpdir(), "cq-state-cache-full-"));
    temporaryDirectories.push(repository, state);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.ts"), "export const a = 2;\n");
    await git(repository, ["add", "--all", "--"]);
    const entries = join(state, "entries");
    await mkdir(entries, { mode: 0o700 });
    const blockingFiles =
      DEFAULT_CACHE_LIMITS.maxEntries +
      DEFAULT_CACHE_LIMITS.maxCleanupEntries +
      1;
    for (let index = 0; index < blockingFiles; index += 1) {
      await writeFile(
        join(entries, `unknown-${index.toString()}`),
        "blocked\n",
        { mode: 0o600 },
      );
    }
    const provider = new FakeProvider();

    const previous = process.cwd();
    const previousState = process.env.CQ_STATE_DIR;
    const previousCache = process.env.CQ_CACHE_DIR;
    process.chdir(repository);
    process.env.CQ_STATE_DIR = state;
    process.env.CQ_CACHE_DIR = state;
    try {
      const result = await runReviewCommand({
        staged: true,
        provider,
        format: "terminal",
      });

      expect(result.exitCode).toBe(3);
      expect(result.output).toContain("Gate: INCOMPLETE");
      expect(result.output).toContain("CACHE_CAPACITY_EXCEEDED");
      expect(result.output).not.toContain("Cache: hit");
      expect(provider.requests).toBeGreaterThan(0);
      const storedRuns = (await readdir(join(state, "runs"))).filter((name) =>
        name.endsWith(".json"),
      );
      expect(storedRuns).toHaveLength(1);
    } finally {
      process.chdir(previous);
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
      if (previousCache === undefined) delete process.env.CQ_CACHE_DIR;
      else process.env.CQ_CACHE_DIR = previousCache;
    }
  });

  test("forwards command cancellation and releases a contended waiter slot", async () => {
    const repository = await mkdtemp(
      join(tmpdir(), "cq-review-cancel-waiter-"),
    );
    const state = await mkdtemp(join(tmpdir(), "cq-state-cancel-waiter-"));
    temporaryDirectories.push(repository, state);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.ts"), "export const a = 2;\n");
    await git(repository, ["add", "--all", "--"]);
    const provider = new BlockingFakeProvider();
    const controller = new AbortController();

    const previous = process.cwd();
    const previousState = process.env.CQ_STATE_DIR;
    const previousCache = process.env.CQ_CACHE_DIR;
    process.chdir(repository);
    process.env.CQ_STATE_DIR = state;
    process.env.CQ_CACHE_DIR = state;
    let winner: Promise<ReviewCommandResult> | undefined;
    let loser: Promise<ReviewCommandResult> | undefined;
    try {
      winner = runReviewCommand({ staged: true, provider });
      await provider.started;
      loser = runReviewCommand({
        staged: true,
        provider,
        signal: controller.signal,
      });
      await waitForCondition(async () => (await lockRoots(state)) >= 2);
      controller.abort();

      const cancellation = await Promise.race([
        loser.then(
          () => "resolved" as const,
          (error: unknown) => error,
        ),
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => {
            resolve("timed-out");
          }, 250);
        }),
      ]);

      expect(cancellation).not.toBe("timed-out");
      expect(cancellation).not.toBe("resolved");
      expect(cancellation).toMatchObject({ name: "AbortError" });
      await waitForCondition(async () => (await lockRoots(state)) === 1);
    } finally {
      provider.release();
      await winner;
      await loser?.catch(() => undefined);
      process.chdir(previous);
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
      if (previousCache === undefined) delete process.env.CQ_CACHE_DIR;
      else process.env.CQ_CACHE_DIR = previousCache;
    }
  });

  test("review fails closed with actionable error when user config is missing", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-cli-"));
    temporaryDirectories.push(repository);
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.ts"), "export const a = 2;\n");
    await git(repository, ["add", "--all", "--"]);

    const previous = process.cwd();
    process.chdir(repository);
    try {
      const result = await runReviewCommand({
        staged: true,
        configPath: join(repository, "missing-user-config.yaml"),
        format: "terminal",
      });
      expect(result.exitCode).toBe(2);
      expect(result.output).toMatch(/Trusted user config not found|not found/i);
    } finally {
      process.chdir(previous);
    }
  });

  test("review resolves provider from trusted user config path", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-review-cli-"));
    const configDir = await mkdtemp(join(tmpdir(), "cq-config-"));
    const state = await mkdtemp(join(tmpdir(), "cq-state-"));
    temporaryDirectories.push(repository, configDir, state);
    const fakeCli = fileURLToPath(
      new URL("../fixtures/providers/fake-cli.mjs", import.meta.url),
    );
    await chmod(fakeCli, 0o700);
    const configPath = join(configDir, "config.yaml");
    await writeFile(
      configPath,
      [
        'schemaVersion: "1"',
        "defaultProvider: fake",
        "providers:",
        "  - name: fake",
        "    kind: codex_cli",
        `    executable: ${fakeCli}`,
        "    allowedModels: [test-model]",
        "    defaultModel: test-model",
        "",
      ].join("\n"),
      "utf8",
    );
    await git(repository, ["init", "--quiet"]);
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "a.ts"), "export const a = 2;\n");
    await git(repository, ["add", "--all", "--"]);

    const previous = process.cwd();
    const previousState = process.env.CQ_STATE_DIR;
    process.chdir(repository);
    process.env.CQ_STATE_DIR = state;
    try {
      const result = await runReviewCommand({
        staged: true,
        configPath,
        format: "terminal",
        disableSingleFlight: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Provider: fake");
      expect(result.output).toContain("Gate:");
      expect(result.output).not.toContain("ScoreGate:");
      expect(result.output).not.toContain("\nScore:\n");
    } finally {
      process.chdir(previous);
      if (previousState === undefined) delete process.env.CQ_STATE_DIR;
      else process.env.CQ_STATE_DIR = previousState;
    }
  });

  test("cli help lists review command", async () => {
    const chunks: string[] = [];
    const exitCode = await runCli(["--help"], {
      stdout: {
        write(chunk: string) {
          chunks.push(chunk);
        },
      },
      stderr: { write() {} },
    });
    expect(exitCode).toBe(0);
    expect(chunks.join("")).toContain("review");
  });
});
