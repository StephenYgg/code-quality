import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SCORE_MODEL,
  validateScoreModel,
} from "../../../src/core/scoring.js";
import {
  ProfileScoreModelError,
  materializeProfileScoreModel,
  scoreModelFingerprint,
} from "../../../src/review/profile-score-model.js";
import { bindReviewPolicy } from "../../../src/review/policy-binding.js";

describe("profile score model materialization", () => {
  test("applies absolute one-decimal major and minor weights without mutating the default", () => {
    const before = JSON.stringify(DEFAULT_SCORE_MODEL);
    const first = DEFAULT_SCORE_MODEL.majors[0];
    const second = DEFAULT_SCORE_MODEL.majors[1];
    if (first === undefined || second === undefined)
      throw new Error("model incomplete");
    const model = materializeProfileScoreModel(
      {
        id: "cq-default-100",
        majorWeights: {
          [first.id]: 19,
          [second.id]: 21,
        },
        minorWeights: {
          [first.minors[0]?.id ?? "missing"]: 3,
          [first.minors[1]?.id ?? "missing"]: 4,
          [first.minors[2]?.id ?? "missing"]: 4,
          [first.minors[3]?.id ?? "missing"]: 4,
          [first.minors[4]?.id ?? "missing"]: 4,
          [second.minors[0]?.id ?? "missing"]: 4,
          [second.minors[1]?.id ?? "missing"]: 4,
          [second.minors[2]?.id ?? "missing"]: 4,
          [second.minors[3]?.id ?? "missing"]: 3,
          [second.minors[4]?.id ?? "missing"]: 3,
          [second.minors[5]?.id ?? "missing"]: 3,
        },
      },
      "f".repeat(64),
    );

    expect(model.majors[0]?.weightTenths).toBe(190);
    expect(model.majors[1]?.weightTenths).toBe(210);
    expect(model.majors[0]?.minors[0]?.weightTenths).toBe(30);
    expect(model.profileHash).toBe("f".repeat(64));
    expect(model.version).not.toBe(DEFAULT_SCORE_MODEL.version);
    expect(validateScoreModel(model)).toEqual([]);
    expect(JSON.stringify(DEFAULT_SCORE_MODEL)).toBe(before);
  });

  test.each([
    ["unknown model", { id: "custom-model" }],
    ["unknown major", { majorWeights: { invented: 12 } }],
    ["unknown minor", { minorWeights: { invented: 2 } }],
    ["invalid major total", { majorWeights: { correctness: 19 } }],
    ["invalid minor total", { minorWeights: { "intent-contract": 3 } }],
  ])("rejects %s as a policy failure", (_label, selection) => {
    expect(() =>
      materializeProfileScoreModel(selection, "f".repeat(64)),
    ).toThrow(ProfileScoreModelError);
  });

  test("binds repository profile weights into the executable score model", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-score-profile-"));
    try {
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
          "  majorWeights:",
          "    correctness: 19.0",
          "    readability: 21.0",
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

      const binding = await bindReviewPolicy({ repository });

      expect(binding.scoreModel.majors[0]?.weightTenths).toBe(190);
      expect(binding.scoreModel.majors[1]?.weightTenths).toBe(210);
      expect(binding.scoreModel.profileHash).toBe(binding.policyHash);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  test("rejects an unknown repository score model as a policy failure", async () => {
    const repository = await mkdtemp(join(tmpdir(), "cq-score-profile-bad-"));
    try {
      await mkdir(join(repository, ".code-quality"));
      await writeFile(
        join(repository, ".code-quality", "profile.yaml"),
        'schemaVersion: "1"\nid: repository\nversion: 1\nrulePacks: [builtin:universal]\nscoreModel:\n  id: custom-model\n',
      );

      await expect(bindReviewPolicy({ repository })).rejects.toBeInstanceOf(
        ProfileScoreModelError,
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  test("fingerprints full model semantics independent of property insertion order", () => {
    const ordered = {
      ...DEFAULT_SCORE_MODEL,
      ruleVersions: { beta: "2", alpha: "1" },
      majors: DEFAULT_SCORE_MODEL.majors.map((major) => ({
        ...major,
        minors: major.minors.map((minor) => ({ ...minor })),
      })),
    };
    const reordered = {
      majors: ordered.majors,
      roundingMode: ordered.roundingMode,
      ruleVersions: { alpha: "1", beta: "2" },
      version: ordered.version,
      id: ordered.id,
    };
    const changed = {
      ...ordered,
      majors: ordered.majors.map((major, majorIndex) => ({
        ...major,
        minors: major.minors.map((minor, minorIndex) =>
          majorIndex === 0 && minorIndex === 0
            ? { ...minor, required: !minor.required }
            : minor,
        ),
      })),
    };

    expect(scoreModelFingerprint(ordered)).toBe(
      scoreModelFingerprint(reordered),
    );
    expect(scoreModelFingerprint(changed)).not.toBe(
      scoreModelFingerprint(ordered),
    );
    expect(scoreModelFingerprint(ordered)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
