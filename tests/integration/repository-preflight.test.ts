import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { runReviewCommand } from "../../src/commands/review.js";
import {
  collectRepositoryManifest,
  createRepositoryPreflight,
  reconfirmRepository,
  repositoryCaptureToReviewInput,
  RepositoryManifestError,
} from "../../src/git/repository-manifest.js";
import { collectReviewContext } from "../../src/review/context.js";
import {
  createExecutionDescriptor,
  type ExecutionDescriptorInput,
} from "../../src/review/execution-descriptor.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

function requestWithIo(
  repository: string,
  io: {
    readonly afterEnumeration?: () => Promise<void>;
    readonly beforeSourceVerification?: () => Promise<void>;
  },
): Parameters<typeof collectRepositoryManifest>[0] {
  return { repository, io };
}

const descriptorInput: ExecutionDescriptorInput = {
  policy: { hash: "a".repeat(64) },
  provider: {
    name: "fake",
    kind: "codex_cli",
    providerClass: "fake",
    trustedConfigIdentity: "b".repeat(64),
  },
  model: "test-model",
  endpoint: { identity: "c".repeat(64), class: "process" },
  egress: { policy: "classification-v1", class: "local" },
  dataClassification: "internal",
  repository: {
    selector: "full_repository",
    limits: {
      maxFiles: 5_000,
      maxBytes: 50 * 1024 * 1024,
      maxEntries: 20_000,
      maxIndividualFileBytes: 1024 * 1024,
    },
  },
  context: {
    maxFiles: 40,
    maxFileBytes: 64 * 1024,
    maxTotalBytes: 512 * 1024,
    maxSnapshotFiles: 200,
    maxSnapshotExclusions: 200,
    maxSnapshotPathBytes: 4_096,
  },
  budgets: {
    maxChangedFiles: 200,
    maxChangedLines: 10_000,
    maxDiffBytes: 2 * 1024 * 1024,
    maxTokens: 500_000,
    maxOutputTokens: 2_000,
    maxDurationMs: 900_000,
    maxCostUsd: 25,
    maxAttempts: 16,
    maxInFlight: 2,
    maxStages: 7,
  },
  score: {
    enabled: false,
    mode: "review",
    modelFingerprint: "d".repeat(64),
    modelVersion: "1",
  },
  verification: {
    required: true,
    runChecks: { enabled: false, previewOnly: false, commandsHash: null },
  },
  gate: {
    mode: "block",
    blockSeverity: "P2",
    minimumConfidence: "high",
  },
};

const context = createExecutionDescriptor(descriptorInput);

function changedDescriptor(
  mutate: (input: ExecutionDescriptorInput) => ExecutionDescriptorInput,
) {
  return createExecutionDescriptor(mutate(structuredClone(descriptorInput)));
}

async function git(
  repository: string,
  args: readonly string[],
): Promise<string> {
  const result = await executeFile(
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
      encoding: "utf8",
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        PATH: process.env.PATH ?? "",
      },
    },
  );
  return result.stdout.replace(/\n$/u, "");
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "cq-repo-manifest-"));
  temporaryDirectories.push(repository);
  await git(repository, ["init", "--quiet"]);
  return repository;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("full repository preflight", () => {
  test("collects tracked and eligible untracked source without provider calls", async () => {
    const repository = await createRepository();
    await writeFile(
      join(repository, "src.ts"),
      "export const ok = 1;\n",
      "utf8",
    );
    await writeFile(join(repository, "README.md"), "# demo\n", "utf8");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(
      join(repository, "extra.ts"),
      "export const extra = 2;\n",
      "utf8",
    );
    await mkdir(join(repository, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(repository, "node_modules", "pkg", "index.js"),
      "module.exports = 1;\n",
      "utf8",
    );
    await writeFile(join(repository, "image.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(
      join(repository, ".env"),
      "SECRET=abcdefghijklmnopqrstuvwxyz\n",
    );
    await writeFile(join(repository, "ignored.txt"), "nope\n");
    await writeFile(join(repository, ".gitignore"), "ignored.txt\n");

    const capture = await collectRepositoryManifest({ repository }, context);
    const preflight = createRepositoryPreflight(capture, context);

    expect(capture.selected.map((file) => file.path).sort()).toEqual([
      ".gitignore",
      "README.md",
      "extra.ts",
      "src.ts",
    ]);
    expect(
      capture.exclusions.some((item) => item.reason === "dependency"),
    ).toBe(true);
    expect(capture.exclusions.some((item) => item.reason === "binary")).toBe(
      true,
    );
    expect(
      capture.exclusions.some((item) => item.reason === "suspected_secret"),
    ).toBe(true);
    expect(
      capture.exclusions.some((item) => item.reason === "git_ignored"),
    ).toBe(true);
    expect(preflight.selectedFileCount).toBe(4);
    expect(preflight.confirmationHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(preflight.providerClass).toBe("fake");
  });

  test("excludes invalid UTF-8 before repository content selection", async () => {
    const repository = await createRepository();
    await writeFile(
      join(repository, "valid.ts"),
      "export const valid = true;\n",
    );
    await writeFile(join(repository, "invalid.ts"), Buffer.from([0xc3, 0x28]));
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const capture = await collectRepositoryManifest({ repository }, context);
    const preflight = createRepositoryPreflight(capture, context);
    const input = repositoryCaptureToReviewInput(capture);

    expect(capture.selected.map((file) => file.path)).toEqual(["valid.ts"]);
    expect(capture.exclusions).toContainEqual({
      path: "invalid.ts",
      reason: "unsupported_type",
    });
    expect(capture.incomplete).toBe(true);
    expect(preflight.incomplete).toBe(true);
    expect(input.snapshot.incomplete).toBe(true);
    expect(input.contentByPath.has("invalid.ts")).toBe(false);
  });

  test("confirmation rejects stale hashes and accepts matching hashes", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "a.ts"), "export const a = 1;\n", "utf8");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const first = await collectRepositoryManifest({ repository }, context);
    const firstPreflight = createRepositoryPreflight(first, context);
    await expect(
      reconfirmRepository(
        firstPreflight.confirmationHash,
        { repository },
        context,
      ),
    ).resolves.toMatchObject({ contentHash: first.contentHash });

    await writeFile(join(repository, "a.ts"), "export const a = 2;\n", "utf8");
    await expect(
      reconfirmRepository(
        firstPreflight.confirmationHash,
        { repository },
        context,
      ),
    ).rejects.toMatchObject({
      code: "REPOSITORY_CONFIRMATION_MISMATCH",
    } satisfies Partial<RepositoryManifestError>);

    await expect(
      reconfirmRepository("0".repeat(64), { repository }, context),
    ).rejects.toMatchObject({
      code: "REPOSITORY_CONFIRMATION_MISMATCH",
    } satisfies Partial<RepositoryManifestError>);
  });

  test.each([
    [
      "policy",
      () =>
        changedDescriptor((input) => ({
          ...input,
          policy: { hash: "e".repeat(64) },
        })),
    ],
    [
      "provider name",
      () =>
        changedDescriptor((input) => ({
          ...input,
          provider: { ...input.provider, name: "other" },
        })),
    ],
    [
      "provider kind",
      () =>
        changedDescriptor((input) => ({
          ...input,
          provider: { ...input.provider, kind: "claude_cli" },
        })),
    ],
    [
      "provider class",
      () =>
        changedDescriptor((input) => ({
          ...input,
          provider: { ...input.provider, providerClass: "other" },
        })),
    ],
    [
      "trusted config identity",
      () =>
        changedDescriptor((input) => ({
          ...input,
          provider: {
            ...input.provider,
            trustedConfigIdentity: "e".repeat(64),
          },
        })),
    ],
    [
      "model",
      () => changedDescriptor((input) => ({ ...input, model: "other-model" })),
    ],
    [
      "endpoint identity",
      () =>
        changedDescriptor((input) => ({
          ...input,
          endpoint: { ...input.endpoint, identity: "e".repeat(64) },
        })),
    ],
    [
      "endpoint class",
      () =>
        changedDescriptor((input) => ({
          ...input,
          endpoint: { ...input.endpoint, class: "http" },
        })),
    ],
    [
      "egress policy",
      () =>
        changedDescriptor((input) => ({
          ...input,
          egress: { ...input.egress, policy: "classification-v2" },
        })),
    ],
    [
      "egress class",
      () =>
        changedDescriptor((input) => ({
          ...input,
          egress: { ...input.egress, class: "loopback" },
        })),
    ],
    [
      "data classification",
      () =>
        changedDescriptor((input) => ({
          ...input,
          dataClassification: "confidential",
        })),
    ],
    ...(
      [
        "maxChangedFiles",
        "maxChangedLines",
        "maxDiffBytes",
        "maxTokens",
        "maxOutputTokens",
        "maxDurationMs",
        "maxCostUsd",
        "maxAttempts",
        "maxInFlight",
        "maxStages",
      ] as const
    ).map(
      (key) =>
        [
          `budget ${key}`,
          () =>
            changedDescriptor((input) => ({
              ...input,
              budgets: { ...input.budgets, [key]: input.budgets[key] + 1 },
            })),
        ] as const,
    ),
    ...(
      ["maxFiles", "maxBytes", "maxEntries", "maxIndividualFileBytes"] as const
    ).map(
      (key) =>
        [
          `repository limit ${key}`,
          () =>
            changedDescriptor((input) => ({
              ...input,
              repository: {
                ...input.repository,
                limits: {
                  ...input.repository.limits,
                  [key]: input.repository.limits[key] - 1,
                },
              },
            })),
        ] as const,
    ),
    ...(
      [
        "maxFiles",
        "maxFileBytes",
        "maxTotalBytes",
        "maxSnapshotFiles",
        "maxSnapshotExclusions",
        "maxSnapshotPathBytes",
      ] as const
    ).map(
      (key) =>
        [
          `context limit ${key}`,
          () =>
            changedDescriptor((input) => ({
              ...input,
              context: { ...input.context, [key]: input.context[key] - 1 },
            })),
        ] as const,
    ),
    [
      "score mode",
      () =>
        changedDescriptor((input) => ({
          ...input,
          score: { ...input.score, enabled: true, mode: "score" },
        })),
    ],
    [
      "score model fingerprint",
      () =>
        changedDescriptor((input) => ({
          ...input,
          score: { ...input.score, modelFingerprint: "e".repeat(64) },
        })),
    ],
    [
      "score model version",
      () =>
        changedDescriptor((input) => ({
          ...input,
          score: { ...input.score, modelVersion: "2" },
        })),
    ],
    [
      "verification",
      () =>
        changedDescriptor((input) => ({
          ...input,
          verification: {
            ...input.verification,
            runChecks: {
              enabled: true,
              previewOnly: false,
              commandsHash: "e".repeat(64),
            },
          },
        })),
    ],
    [
      "gate threshold",
      () =>
        changedDescriptor((input) => ({
          ...input,
          gate: { ...input.gate, blockSeverity: "P1" },
        })),
    ],
  ] as const)(
    "rejects confirmation when the %s descriptor field changes",
    async (_label, descriptor) => {
      const repository = await createRepository();
      await writeFile(
        join(repository, "a.ts"),
        "export const a = 1;\n",
        "utf8",
      );
      await git(repository, ["add", "--all", "--"]);
      await git(repository, ["commit", "--quiet", "-m", "initial"]);

      const first = await collectRepositoryManifest({ repository }, context);
      const firstPreflight = createRepositoryPreflight(first, context);

      await expect(
        reconfirmRepository(
          firstPreflight.confirmationHash,
          { repository },
          descriptor(),
        ),
      ).rejects.toMatchObject({
        code: "REPOSITORY_CONFIRMATION_MISMATCH",
      } satisfies Partial<RepositoryManifestError>);
    },
  );

  test("rejects invalid execution descriptor hashes and budgets", () => {
    expect(() =>
      createExecutionDescriptor({
        ...descriptorInput,
        policy: { hash: "0".repeat(64) },
      }),
    ).toThrow(/policy hash/iu);
    expect(() =>
      createExecutionDescriptor({
        ...descriptorInput,
        budgets: { ...descriptorInput.budgets, maxTokens: 0 },
      }),
    ).toThrow(/maxTokens/iu);
  });

  test.each([
    [
      "provider kind",
      { provider: { ...descriptorInput.provider, kind: "unknown" } },
    ],
    ["egress class", { egress: { ...descriptorInput.egress, class: "ftp" } }],
    ["data classification", { dataClassification: "secret" }],
    [
      "repository selector",
      { repository: { ...descriptorInput.repository, selector: "range" } },
    ],
    ["score mode", { score: { ...descriptorInput.score, mode: "summary" } }],
    ["gate mode", { gate: { ...descriptorInput.gate, mode: "silent" } }],
    [
      "gate severity",
      { gate: { ...descriptorInput.gate, blockSeverity: "P3" } },
    ],
    [
      "gate confidence",
      { gate: { ...descriptorInput.gate, minimumConfidence: "certain" } },
    ],
  ] as const)("rejects an invalid runtime %s", (_label, override) => {
    expect(() =>
      createExecutionDescriptor({
        ...descriptorInput,
        ...override,
      } as unknown as ExecutionDescriptorInput),
    ).toThrow(/invalid|unsupported/iu);
  });

  test("hard file limits mark the capture incomplete", async () => {
    const repository = await createRepository();
    for (let index = 0; index < 3; index += 1) {
      await writeFile(
        join(repository, `f${String(index)}.ts`),
        `export const n = ${String(index)};\n`,
        "utf8",
      );
    }
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const capture = await collectRepositoryManifest({ repository }, context, {
      maxFiles: 2,
    });
    expect(capture.selected).toHaveLength(2);
    expect(capture.incomplete).toBe(true);
    expect(
      capture.exclusions.some((item) => item.reason === "aggregate_file_limit"),
    ).toBe(true);
  });

  test("accepts exactly maxEntries and rejects the next repository entry", async () => {
    const repository = await createRepository();
    for (let index = 0; index < 3; index += 1) {
      await writeFile(
        join(repository, `entry-${String(index)}.ts`),
        `export const value = ${String(index)};\n`,
      );
    }
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const exact = await collectRepositoryManifest({ repository }, context, {
      maxEntries: 3,
    });
    const overflow = await collectRepositoryManifest({ repository }, context, {
      maxEntries: 2,
    });
    const overflowPreflight = createRepositoryPreflight(overflow, context);

    expect(exact.selected).toHaveLength(3);
    expect(exact.incomplete).toBe(false);
    expect(overflow.selected).toHaveLength(2);
    expect(overflow.incomplete).toBe(true);
    expect(overflowPreflight.exclusionCounts.entry_limit).toBe(1);
  });

  test("counts classified exclusions beyond the display sample cap", async () => {
    const repository = await createRepository();
    for (let index = 0; index < 22; index += 1) {
      await writeFile(
        join(repository, `.env.${String(index).padStart(2, "0")}`),
        `SECRET_${String(index)}=not-selected\n`,
      );
    }
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const capture = await collectRepositoryManifest({ repository }, context, {
      maxEntries: 21,
    });
    const preflight = createRepositoryPreflight(capture, context);

    expect(capture.selected).toHaveLength(0);
    expect(
      capture.exclusions.filter((item) => item.reason === "suspected_secret"),
    ).toHaveLength(20);
    expect(preflight.exclusionCounts.suspected_secret).toBe(21);
    expect(preflight.exclusionCounts.entry_limit).toBe(1);
    expect(capture.incomplete).toBe(true);
  });

  test("counts ignored paths against maxEntries", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, ".gitignore"), "ignored-*.txt\n");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    for (let index = 0; index < 5; index += 1) {
      await writeFile(
        join(repository, `ignored-${String(index)}.txt`),
        "ignored\n",
      );
    }

    const capture = await collectRepositoryManifest({ repository }, context, {
      maxEntries: 5,
    });
    const preflight = createRepositoryPreflight(capture, context);

    expect(capture.incomplete).toBe(true);
    expect(preflight.entryCount).toBe(6);
    expect(preflight.ignoredCount).toBe(5);
    expect(preflight.exclusionCounts.git_ignored).toBe(4);
    expect(preflight.exclusionCounts.entry_limit).toBe(1);
  });

  test("aggregates tracked, untracked, and ignored entries before selection", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, ".gitignore"), "ignored.txt\n");
    await writeFile(
      join(repository, "tracked.ts"),
      "export const tracked = 1;\n",
    );
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(join(repository, "untracked.ts"), "export const u = 1;\n");
    await writeFile(join(repository, "ignored.txt"), "ignored\n");

    const capture = await collectRepositoryManifest({ repository }, context, {
      maxEntries: 3,
    });
    const preflight = createRepositoryPreflight(capture, context);

    expect(capture.trackedCount).toBe(2);
    expect(capture.untrackedCount).toBe(1);
    expect(preflight.ignoredCount).toBe(1);
    expect(preflight.entryCount).toBe(4);
    expect(preflight.exclusionCounts.git_ignored).toBeUndefined();
    expect(preflight.exclusionCounts.entry_limit).toBe(1);
    expect(capture.incomplete).toBe(true);
  });

  test("normalizes repository review content to the visible context set", async () => {
    const repository = await createRepository();
    for (let index = 0; index <= 200; index += 1) {
      await writeFile(
        join(repository, `f${String(index).padStart(3, "0")}.ts`),
        `export const value = ${String(index)};\n`,
      );
    }
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const capture = await collectRepositoryManifest({ repository }, context);
    const preflight = createRepositoryPreflight(capture, context);
    const input = repositoryCaptureToReviewInput(capture);
    const reviewContext = await collectReviewContext(input.snapshot, {
      contentByPath: input.contentByPath,
    });

    expect(preflight.selectedFileCount).toBe(201);
    expect(preflight.incomplete).toBe(false);
    expect(input.snapshot.files).toHaveLength(200);
    expect(input.contentByPath.size).toBe(40);
    expect(input.snapshot.exclusions).toEqual(
      expect.arrayContaining([
        { path: "f040.ts", reason: "file_limit" },
        { path: "f200.ts", reason: "file_limit" },
      ]),
    );
    expect(input.contentByPath.has("f040.ts")).toBe(false);
    expect(input.contentByPath.has("f200.ts")).toBe(false);
    expect(input.snapshot.files.map((file) => file.path)).not.toContain(
      "f200.ts",
    );
    expect(input.snapshot.incomplete).toBe(true);
    expect(reviewContext.files).toHaveLength(40);
    expect(reviewContext.incomplete).toBe(true);
  });

  test("bounds repository review bytes without truncating captured files", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "00-too-large.ts"), "x".repeat(70 * 1024));
    for (let index = 1; index <= 9; index += 1) {
      await writeFile(
        join(repository, `${String(index).padStart(2, "0")}-large.ts`),
        String(index).repeat(60 * 1024),
      );
    }
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);

    const capture = await collectRepositoryManifest({ repository }, context);
    const input = repositoryCaptureToReviewInput(capture);

    expect(capture.selected).toHaveLength(10);
    expect(capture.incomplete).toBe(false);
    expect(input.contentByPath.size).toBe(8);
    expect(input.contentByPath.has("00-too-large.ts")).toBe(false);
    expect(input.contentByPath.has("09-large.ts")).toBe(false);
    expect(input.snapshot.exclusions).toEqual(
      expect.arrayContaining([
        { path: "00-too-large.ts", reason: "file_limit" },
        { path: "09-large.ts", reason: "aggregate_byte_limit" },
      ]),
    );
    expect(
      [...input.contentByPath.values()].reduce(
        (total, bytes) => total + bytes.length,
        0,
      ),
    ).toBeLessThanOrEqual(512 * 1024);
    expect(input.snapshot.incomplete).toBe(true);
  });

  test("excludes a tracked path whose parent is an external symlink", async () => {
    const repository = await createRepository();
    const directory = join(repository, "src");
    await mkdir(directory);
    await writeFile(join(directory, "value.ts"), "repository bytes\n", "utf8");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const outside = await mkdtemp(join(tmpdir(), "cq-repo-sentinel-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "value.ts"), "EXTERNAL_SENTINEL\n", "utf8");
    await rm(directory, { recursive: true });
    await symlink(outside, directory, "dir");

    const capture = await collectRepositoryManifest({ repository }, context);

    expect(capture.incomplete).toBe(true);
    expect(capture.selected.map((file) => file.path)).not.toContain(
      "src/value.ts",
    );
    expect(
      capture.selected.some((file) =>
        file.bytes.includes(Buffer.from("EXTERNAL_SENTINEL")),
      ),
    ).toBe(false);
  });

  test("rejects an external parent symlink introduced after enumeration", async () => {
    const repository = await createRepository();
    const directory = join(repository, "src");
    await mkdir(directory);
    await writeFile(join(directory, "value.ts"), "repository bytes\n", "utf8");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const outside = await mkdtemp(join(tmpdir(), "cq-repo-barrier-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "value.ts"), "EXTERNAL_SENTINEL\n", "utf8");
    const request = requestWithIo(repository, {
      afterEnumeration: async () => {
        await rename(directory, join(outside, "original-src"));
        await symlink(outside, directory, "dir");
      },
    });

    await expect(
      collectRepositoryManifest(request, context),
    ).rejects.toMatchObject({ code: "REPOSITORY_SOURCE_STALE" });
  });

  test("rejects HEAD changes after selected files are captured", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "value.ts"), "one\n", "utf8");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const request = requestWithIo(repository, {
      beforeSourceVerification: async () => {
        await writeFile(join(repository, "head.ts"), "head change\n", "utf8");
        await git(repository, ["add", "--all", "--"]);
        await git(repository, ["commit", "--quiet", "-m", "head change"]);
      },
    });

    await expect(
      collectRepositoryManifest(request, context),
    ).rejects.toMatchObject({ code: "REPOSITORY_SOURCE_STALE" });
  });

  test("rejects tracked or untracked path-set changes after capture", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "value.ts"), "one\n", "utf8");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const request = requestWithIo(repository, {
      beforeSourceVerification: async () => {
        await writeFile(join(repository, "late.ts"), "late\n", "utf8");
      },
    });

    await expect(
      collectRepositoryManifest(request, context),
    ).rejects.toMatchObject({ code: "REPOSITORY_SOURCE_STALE" });
  });

  test("rejects path-set changes when enumeration already overflowed", async () => {
    const repository = await createRepository();
    for (let index = 0; index < 3; index += 1) {
      await writeFile(
        join(repository, `value-${String(index)}.ts`),
        `export const value = ${String(index)};\n`,
      );
    }
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const request = requestWithIo(repository, {
      beforeSourceVerification: async () => {
        await writeFile(
          join(repository, "late.ts"),
          "export const late = 1;\n",
        );
      },
    });

    await expect(
      collectRepositoryManifest(request, context, { maxEntries: 1 }),
    ).rejects.toMatchObject({ code: "REPOSITORY_SOURCE_STALE" });
  });

  test("rejects same-path index epoch changes after capture", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.ts");
    await writeFile(path, "base\n", "utf8");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    await writeFile(path, "worktree\n", "utf8");
    await git(repository, ["add", "--", "value.ts"]);
    const request = requestWithIo(repository, {
      beforeSourceVerification: async () => {
        await git(repository, ["reset", "--quiet", "HEAD", "--", "value.ts"]);
      },
    });

    await expect(
      collectRepositoryManifest(request, context),
    ).rejects.toMatchObject({ code: "REPOSITORY_SOURCE_STALE" });
  });

  test("rejects same-byte selected-file inode replacement", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.ts");
    await writeFile(path, "same bytes\n", "utf8");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const outside = await mkdtemp(join(tmpdir(), "cq-repo-inode-"));
    temporaryDirectories.push(outside);
    const request = requestWithIo(repository, {
      beforeSourceVerification: async () => {
        await rename(path, join(outside, "original.ts"));
        await writeFile(path, "same bytes\n", "utf8");
      },
    });

    await expect(
      collectRepositoryManifest(request, context),
    ).rejects.toMatchObject({ code: "REPOSITORY_SOURCE_STALE" });
  });

  test("rejects an in-place content ABA during capture", async () => {
    const repository = await createRepository();
    const path = join(repository, "value.ts");
    await writeFile(path, "original\n", "utf8");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const request = requestWithIo(repository, {
      beforeSourceVerification: async () => {
        await writeFile(path, "mutated!\n", "utf8");
        await writeFile(path, "original\n", "utf8");
      },
    });

    await expect(
      collectRepositoryManifest(request, context),
    ).rejects.toMatchObject({ code: "REPOSITORY_SOURCE_STALE" });
  });

  test("maps repository source staleness to CLI INCOMPLETE", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "value.ts"), "one\n", "utf8");
    await git(repository, ["add", "--all", "--"]);
    await git(repository, ["commit", "--quiet", "-m", "initial"]);
    const options = {
      repository,
      preflight: true,
      repositoryIo: {
        afterEnumeration: async () => {
          await writeFile(join(repository, "late.ts"), "late\n", "utf8");
        },
      },
    };

    const result = await runReviewCommand(options);

    expect(result.exitCode).toBe(3);
    expect(result.output).toMatch(/INCOMPLETE/u);
  });
});
