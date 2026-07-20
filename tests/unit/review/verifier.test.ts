import { describe, expect, test } from "vitest";

import { createReviewSnapshot } from "../../../src/core/snapshots.js";
import { createFinding, dedupeFindings } from "../../../src/core/findings.js";
import type { ReviewContextBundle } from "../../../src/review/context.js";
import type { StageCandidate } from "../../../src/review/stage-output.js";
import { verifyCandidates } from "../../../src/review/verifier.js";

const source = [
  "export function load(id: string) {",
  "  return loadResource(id);",
  "}",
].join("\n");

function snapshot() {
  return createReviewSnapshot({
    inputKind: "staged",
    scope: "change",
    repository: "/tmp/repo",
    head: "a".repeat(64),
    files: [{ path: "src/auth.ts", status: "modified", binary: false }],
    exclusions: [],
    incomplete: false,
    diff: [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,3 +1,3 @@",
      " export function load(id: string) {",
      "-  return oldLoad(id);",
      "+  return loadResource(id);",
      " }",
    ].join("\n"),
  });
}

function context(): ReviewContextBundle {
  return Object.freeze({
    files: Object.freeze([
      Object.freeze({
        path: "src/auth.ts",
        content: source,
        byteLength: Buffer.byteLength(source),
        truncated: false,
      }),
    ]),
    totalBytes: Buffer.byteLength(source),
    incomplete: false,
    exclusions: Object.freeze([]),
  });
}

function candidate(overrides: Partial<StageCandidate> = {}): StageCandidate {
  return {
    title: "Authorization is skipped",
    severity: "P1",
    evidence: "The resource load has no ownership guard.",
    path: "src/auth.ts",
    startLine: 2,
    endLine: 2,
    sourceQuote: "return loadResource(id);",
    impact: "Cross-tenant data can be read.",
    remediation: "Check ownership before the load.",
    ...overrides,
  };
}

describe("candidate evidence verification", () => {
  test("keeps source-supported blocking behavior corroborated without an independent verifier", () => {
    const [finding] = verifyCandidates(
      "security",
      [candidate()],
      snapshot(),
      context(),
    );

    expect(finding).toMatchObject({
      lifecycle: "corroborated",
      blockingVerificationUnresolved: true,
      location: { path: "src/auth.ts", startLine: 2, endLine: 2 },
    });
    expect(finding?.verification).toMatch(
      /source corroborated.*behavior unverified/i,
    );
  });

  test("confirms blocking behavior only from a trusted deterministic fact", () => {
    const [finding] = verifyCandidates(
      "security",
      [candidate()],
      snapshot(),
      context(),
      {
        provider: "trusted-test",
        blockingEvidenceVerifier: {
          verify: () => ({
            kind: "deterministic" as const,
            statement: "Control-flow analysis found no ownership guard",
            path: "src/auth.ts",
            startLine: 2,
            endLine: 2,
          }),
        },
      },
    );

    expect(finding).toMatchObject({
      lifecycle: "confirmed",
      confidence: "high",
    });
    expect(finding?.verification).toMatch(/deterministic.*ownership guard/i);
  });

  test("does not turn a matching clean return statement into a fictional P1 leak", () => {
    const cleanSource = "return x;";
    const cleanSnapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/value.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
    });
    const cleanContext: ReviewContextBundle = {
      files: [
        {
          path: "src/value.ts",
          content: cleanSource,
          byteLength: Buffer.byteLength(cleanSource),
          truncated: false,
        },
      ],
      totalBytes: Buffer.byteLength(cleanSource),
      incomplete: false,
      exclusions: [],
    };

    const [finding] = verifyCandidates(
      "security",
      [
        candidate({
          title: "Secret is leaked",
          evidence: "The return statement exposes a cross-tenant secret.",
          path: "src/value.ts",
          startLine: 1,
          endLine: 1,
          sourceQuote: "return x;",
        }),
      ],
      cleanSnapshot,
      cleanContext,
    );

    expect(finding?.lifecycle).toBe("corroborated");
    expect(finding?.blockingVerificationUnresolved).toBe(true);
    expect(finding?.verification).toMatch(/behavior unverified/i);
  });

  test("keeps a fabricated filename mention uncertain", () => {
    const [finding] = verifyCandidates(
      "security",
      [
        candidate({
          sourceQuote: "authorizeTenant(ownerId);",
          evidence:
            "src/auth.ts definitely omits authorizeTenant(ownerId) on this path.",
        }),
      ],
      snapshot(),
      context(),
    );

    expect(finding?.lifecycle).toBe("uncertain");
    expect(finding?.verification).toMatch(/quote.*not match/i);
  });

  test.each(["r", "loadResource(id)"])(
    "does not confirm blocking evidence from a non-substantive quote: %s",
    (sourceQuote) => {
      const [finding] = verifyCandidates(
        "security",
        [candidate({ sourceQuote })],
        snapshot(),
        context(),
      );

      expect(finding?.lifecycle).toBe("uncertain");
      expect(finding?.verification).toMatch(/substantive|complete.*range/i);
    },
  );

  test("verifies deleted source lines against the immutable old diff side", () => {
    const deleted = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/legacy.ts", status: "deleted", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: [
        "diff --git a/src/legacy.ts b/src/legacy.ts",
        "--- a/src/legacy.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-export const legacySecret = readSecret();",
        "-publish(legacySecret);",
      ].join("\n"),
    });

    const [finding] = verifyCandidates(
      "security",
      [
        candidate({
          severity: "P2",
          path: "src/legacy.ts",
          startLine: 2,
          endLine: 2,
          sourceQuote: "publish(legacySecret);",
        }),
      ],
      deleted,
    );

    expect(finding?.lifecycle).toBe("confirmed");
    expect(finding?.verification).toMatch(/immutable diff/i);
    expect(finding?.disposition).toBe("new");
  });

  test("classifies added hunk evidence as new and context hunk evidence as preexisting", () => {
    const reviewSnapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/auth.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: [
        "diff --git a/src/auth.ts b/src/auth.ts",
        "--- a/src/auth.ts",
        "+++ b/src/auth.ts",
        "@@ -1 +1,2 @@",
        " export function load() {}",
        "+export const addedValue = load();",
      ].join("\n"),
    });
    const findings = verifyCandidates(
      "behavior",
      [
        candidate({
          severity: "P2",
          title: "Existing line",
          startLine: 1,
          endLine: 1,
          sourceQuote: "export function load() {}",
        }),
        candidate({
          severity: "P2",
          title: "Added line",
          startLine: 2,
          endLine: 2,
          sourceQuote: "export const addedValue = load();",
        }),
      ],
      reviewSnapshot,
    );

    expect(findings[0]?.disposition).toBe("preexisting");
    expect(findings[1]?.disposition).toBe("new");
  });

  test("uses unknown for modified context outside captured diff ranges", () => {
    const [finding] = verifyCandidates(
      "behavior",
      [candidate({ severity: "P2" })],
      createReviewSnapshot({
        inputKind: "staged",
        scope: "change",
        repository: "/tmp/repo",
        head: "a".repeat(64),
        files: [{ path: "src/auth.ts", status: "modified", binary: false }],
        exclusions: [],
        incomplete: false,
      }),
      context(),
    );

    expect(finding?.lifecycle).toBe("confirmed");
    expect(finding?.disposition).toBe("unknown");
  });

  test("classifies repository context and pure renames as preexisting", () => {
    const repositorySnapshot = createReviewSnapshot({
      inputKind: "repository",
      scope: "repository",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path: "src/auth.ts", status: "modified", binary: false }],
      exclusions: [],
      incomplete: false,
    });
    const renamedSnapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [
        {
          path: "src/auth.ts",
          previousPath: "src/old-auth.ts",
          status: "renamed",
          binary: false,
        },
      ],
      exclusions: [],
      incomplete: false,
      diff: [
        "diff --git a/src/old-auth.ts b/src/auth.ts",
        "similarity index 100%",
        "rename from src/old-auth.ts",
        "rename to src/auth.ts",
      ].join("\n"),
    });

    const [repositoryFinding] = verifyCandidates(
      "behavior",
      [candidate({ severity: "P2" })],
      repositorySnapshot,
      context(),
    );
    const [renamedFinding] = verifyCandidates(
      "behavior",
      [candidate({ severity: "P2" })],
      renamedSnapshot,
      context(),
    );

    expect(repositoryFinding?.disposition).toBe("preexisting");
    expect(renamedFinding?.disposition).toBe("preexisting");
  });

  test("decodes C-style quoted UTF-8 and tab paths", () => {
    const path = "src/中\tvalue.ts";
    const quotedSnapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [{ path, status: "added", binary: false }],
      exclusions: [],
      incomplete: false,
      diff: [
        `diff --git "a/src/\\344\\270\\255\\tvalue.ts" "b/src/\\344\\270\\255\\tvalue.ts"`,
        "--- /dev/null",
        '+++ "b/src/\\344\\270\\255\\tvalue.ts"',
        "@@ -0,0 +1 @@",
        "+export const quotedValue = 1;",
      ].join("\n"),
    });

    const [finding] = verifyCandidates(
      "behavior",
      [
        candidate({
          severity: "P2",
          path,
          startLine: 1,
          endLine: 1,
          sourceQuote: "export const quotedValue = 1;",
        }),
      ],
      quotedSnapshot,
    );

    expect(finding?.lifecycle).toBe("confirmed");
    expect(finding?.disposition).toBe("new");
  });

  test("maps renamed old-side evidence onto the new snapshot path", () => {
    const path = "src/new\t中.ts";
    const renamedSnapshot = createReviewSnapshot({
      inputKind: "staged",
      scope: "change",
      repository: "/tmp/repo",
      head: "a".repeat(64),
      files: [
        {
          path,
          previousPath: "src/old\t中.ts",
          status: "renamed",
          binary: false,
        },
      ],
      exclusions: [],
      incomplete: false,
      diff: [
        `diff --git "a/src/old\\t\\344\\270\\255.ts" "b/src/new\\t\\344\\270\\255.ts"`,
        '--- "a/src/old\\t\\344\\270\\255.ts"',
        '+++ "b/src/new\\t\\344\\270\\255.ts"',
        "@@ -1 +1 @@",
        "-export const previousName = 1;",
        "+export const currentName = 1;",
      ].join("\n"),
    });

    const [finding] = verifyCandidates(
      "behavior",
      [
        candidate({
          severity: "P2",
          path,
          startLine: 1,
          endLine: 1,
          sourceQuote: "export const previousName = 1;",
        }),
      ],
      renamedSnapshot,
    );

    expect(finding?.lifecycle).toBe("confirmed");
    expect(finding?.location?.path).toBe(path);
    expect(finding?.disposition).toBe("new");
  });

  test("keeps evidence outside captured source ranges uncertain", () => {
    const [finding] = verifyCandidates(
      "security",
      [candidate({ startLine: 99, endLine: 99 })],
      snapshot(),
      context(),
    );

    expect(finding?.lifecycle).toBe("uncertain");
    expect(finding?.verification).toMatch(/outside.*captured/i);
  });

  test("rejects a wide range before iterating over provider-controlled lines", () => {
    const [finding] = verifyCandidates(
      "security",
      [candidate({ startLine: 1, endLine: 1_000 })],
      snapshot(),
      context(),
    );

    expect(finding?.lifecycle).toBe("uncertain");
    expect(finding?.verification).toMatch(/range.*limit/i);
  });

  test("does not confirm nonblocking candidates from generic prose", () => {
    const [finding] = verifyCandidates(
      "readability",
      [
        candidate({
          severity: "P3",
          sourceQuote: "a quote that does not exist",
          evidence: "This code is generally difficult to maintain.",
        }),
      ],
      snapshot(),
      context(),
    );

    expect(finding?.lifecycle).toBe("uncertain");
  });

  test("preserves conflicting candidates as uncertain with a reason", () => {
    const findings = verifyCandidates(
      "security",
      [
        candidate({ severity: "P2", title: "Authorization Is Skipped" }),
        candidate({ severity: "P3", title: "  Ａuthorization Is Skipped  " }),
      ],
      snapshot(),
      context(),
    );

    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.lifecycle === "uncertain")).toBe(
      true,
    );
    expect(
      findings.every((finding) => /conflict/i.test(finding.verification ?? "")),
    ).toBe(true);
  });

  test("does not let deduplication hide a cross-stage severity conflict", () => {
    const first = verifyCandidates(
      "security",
      [candidate({ severity: "P2", title: "Authorization Is Skipped" })],
      snapshot(),
      context(),
    );
    const second = verifyCandidates(
      "permissions",
      [
        candidate({
          severity: "P3",
          title: "  Ａuthorization Is Skipped  ",
        }),
      ],
      snapshot(),
      context(),
    );

    const mergedFindings = dedupeFindings([...first, ...second]);
    const [merged] = mergedFindings;

    expect(mergedFindings).toHaveLength(1);
    expect(merged?.lifecycle).toBe("uncertain");
    expect(merged?.verification).toMatch(/conflict/i);
  });

  test("does not mistake confirmed and reported lifecycle states for a conflict", () => {
    const common = {
      id: "finding-1",
      title: "Authorization is skipped",
      severity: "P1" as const,
      disposition: "new" as const,
      confidence: "high" as const,
      stages: ["security"],
      location: { path: "src/auth.ts", startLine: 2, endLine: 2 },
      evidence: "The resource load has no ownership guard.",
      impact: "Cross-tenant data can be read.",
      remediation: "Check ownership before the load.",
    };
    const confirmed = createFinding({ ...common, lifecycle: "confirmed" });
    const reported = createFinding({
      ...common,
      id: "finding-2",
      title: "  ＡUTHORIZATION IS SKIPPED  ",
      stages: ["permissions"],
      lifecycle: "reported",
    });

    const mergedFindings = dedupeFindings([confirmed, reported]);
    const [merged] = mergedFindings;

    expect(mergedFindings).toHaveLength(1);
    expect(merged?.lifecycle).not.toBe("uncertain");
  });

  test("does not deduplicate findings with different end lines", () => {
    const common = {
      title: "Authorization is skipped",
      severity: "P1" as const,
      disposition: "new" as const,
      confidence: "high" as const,
      stages: ["security"],
      evidence: "The resource load has no ownership guard.",
      impact: "Cross-tenant data can be read.",
      remediation: "Check ownership before the load.",
      lifecycle: "confirmed" as const,
    };
    const first = createFinding({
      ...common,
      id: "finding-1",
      location: { path: "src/auth.ts", startLine: 2, endLine: 2 },
    });
    const second = createFinding({
      ...common,
      id: "finding-2",
      location: { path: "src/auth.ts", startLine: 2, endLine: 4 },
    });

    expect(dedupeFindings([first, second])).toHaveLength(2);
  });
});
