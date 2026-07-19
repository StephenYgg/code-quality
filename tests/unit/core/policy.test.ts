import {
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  resolveEffectivePolicy,
  type TrustedRulePackLoader,
  validatePolicyDocument,
} from "../../../src/core/policy.js";
import {
  MAX_POLICY_DIAGNOSTICS_PER_DOCUMENT,
  MAX_POLICY_DIAGNOSTICS_PER_RESOLUTION,
  PolicyDiagnosticCollector,
} from "../../../src/core/policy-diagnostics.js";
import { loadPolicyDocument } from "../../../src/core/policy-schema.js";
import { limitPolicyDiagnostics } from "../../../src/core/policy-structure.js";
import { canonicalizePolicy } from "../../../src/core/policy-values.js";
import { DEFAULT_SCORE_MODEL } from "../../../src/core/scoring.js";

const temporaryDirectories: string[] = [];
const NOW = new Date("2026-07-19T12:00:00.000Z");

function testWaiverDiscoveryIo() {
  const pathByIdentity = new Map<string, string>();
  const identityKey = (stats: { readonly dev: bigint; readonly ino: bigint }) =>
    `${String(stats.dev)}:${String(stats.ino)}`;
  return {
    realpath,
    stat: async (path: string) => {
      const current = await stat(path, { bigint: true });
      pathByIdentity.set(identityKey(current), path);
      return current;
    },
    openDescriptorDirectory: async (descriptor: {
      readonly handle: FileHandle;
    }) => {
      const openedStats = await descriptor.handle.stat({ bigint: true });
      const path = pathByIdentity.get(identityKey(openedStats));
      if (path === undefined) {
        throw new Error("Test descriptor identity was not observed");
      }
      const directory = await opendir(path);
      return { directory, stats: openedStats };
    },
  };
}

function resolvePolicyWithWaiverDirectories(
  request: Parameters<typeof resolveEffectivePolicy>[0],
) {
  return resolveEffectivePolicy(request, {
    trustedWaiverDiscoveryIo: testWaiverDiscoveryIo(),
  });
}

type CaptureStructuredIdentity = (handle: FileHandle) => Promise<unknown>;
type VerifyStructuredIdentity = (
  requestedPath: string,
  resolvedPath: string,
  handle: FileHandle,
  identity: unknown,
  source: string,
) => Promise<void>;

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "cq-policy-"));
  temporaryDirectories.push(repository);
  return repository;
}

async function writeRepositoryFile(
  repository: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(repository, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

function waiverYaml(id: string, overrides = ""): string {
  return `schemaVersion: "1"
id: ${id}
ruleId: CQ-READ-003
ruleVersion:
  minimum: 1
  maximum: 1
repository: StephenYgg/example
scope:
  paths: [src/export/**]
reason: The behavior remains stable during a bounded migration.
riskAcceptance: The owner accepts this temporary readability risk.
approver: engineering-director
owner: export-team
compensatingControls:
  - Characterization tests cover every current outcome.
trackingIssue: https://example.invalid/issues/123
createdAt: 2026-07-01T00:00:00.000Z
expiresAt: 2026-08-01T00:00:00.000Z
${overrides}`;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("strict policy contracts", () => {
  test("rejects pathname replacement after capturing the opened config identity", async () => {
    const repository = await createRepository();
    const path = join(repository, "profile.yaml");
    await writeFile(path, 'schemaVersion: "1"\n', "utf8");
    const handle = await open(path, "r");
    try {
      const module = await import("../../../src/core/config.js");
      const captureCandidate: unknown = Reflect.get(
        module,
        "captureStructuredIdentity",
      );
      const verifyCandidate: unknown = Reflect.get(
        module,
        "verifyStructuredIdentity",
      );

      expect(captureCandidate).toBeTypeOf("function");
      expect(verifyCandidate).toBeTypeOf("function");
      if (
        typeof captureCandidate !== "function" ||
        typeof verifyCandidate !== "function"
      ) {
        return;
      }
      const capture = captureCandidate as CaptureStructuredIdentity;
      const verify = verifyCandidate as VerifyStructuredIdentity;
      const capturedIdentity = await capture(handle);
      await rename(path, join(repository, "opened-profile.yaml"));
      await writeFile(path, 'schemaVersion: "2"\n', "utf8");

      await expect(
        verify(path, path, handle, capturedIdentity, "profile.yaml"),
      ).rejects.toThrow("changed during policy resolution");
    } finally {
      await handle.close();
    }
  });

  test("loads the valid built-in rule pack with stable rule IDs and hashes", async () => {
    const repository = await createRepository();

    const first = await resolveEffectivePolicy({ repository });
    const second = await resolveEffectivePolicy({ repository });

    expect(first.diagnostics).toEqual([]);
    expect(first.policy?.rules.map((rule) => rule.id)).toEqual(
      expect.arrayContaining([
        "CQ-READ-001",
        "CQ-READ-002",
        "CQ-READ-003",
        "CQ-READ-004",
        "CQ-READ-005",
        "CQ-READ-006",
        "CQ-READ-007",
        "CQ-READ-008",
        "CQ-UNIV-001",
        "CQ-CONC-001",
        "CQ-SEC-001",
        "CQ-TEST-001",
        "CQ-COMPAT-001",
        "CQ-HYGIENE-001",
      ]),
    );
    expect(first.policyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.policyHash).toBe(second.policyHash);
    expect(
      first.sources.every((source) => /^[a-f0-9]{64}$/u.test(source.sha256)),
    ).toBe(true);
    expect(Object.isFrozen(first.policy)).toBe(true);
    expect(Object.isFrozen(first.policy?.rules)).toBe(true);
    expect(Object.isFrozen(first.policy?.rules[0])).toBe(true);
  });

  test("rejects unknown profile keys with source-aware diagnostics", async () => {
    const repository = await createRepository();
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      `schemaVersion: "1"
id: repository
version: 1
rulePacks:
  - builtin:universal
unknownPolicy: true
`,
    );

    const result = await resolveEffectivePolicy({ repository });

    expect(result.policy).toBeUndefined();
    expect(result.policyHash).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_INVALID",
        source: ".code-quality/profile.yaml",
        path: "/unknownPolicy",
      }),
    );
    expect(result.sources.map((source) => source.source)).toEqual([
      "profiles/default.yaml",
      ".code-quality/profile.yaml",
    ]);
  });

  test("does not echo YAML source excerpts or secret sentinels in diagnostics", async () => {
    const repository = await createRepository();
    const sentinel = "CQ_SECRET_SENTINEL_DO_NOT_ECHO";
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      `schemaVersion: "1"\nprovider: [${sentinel}\n`,
    );

    const result = await resolveEffectivePolicy({ repository });
    const serialized = JSON.stringify(result.diagnostics);
    const parseDiagnostic = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "CONFIG_PARSE_ERROR",
    );

    expect(result.policy).toBeUndefined();
    expect(parseDiagnostic).toBeDefined();
    expect(parseDiagnostic?.line).toBeTypeOf("number");
    expect(parseDiagnostic?.column).toBeTypeOf("number");
    expect(serialized).not.toContain(sentinel);
  });

  test("does not echo JSON source excerpts or secret sentinels in diagnostics", async () => {
    const repository = await createRepository();
    const sentinel = "CQ_SECRET_SENTINEL_DO_NOT_ECHO";
    await writeRepositoryFile(
      repository,
      ".code-quality/waivers/invalid.json",
      `{"${sentinel}":}`,
    );

    const result = await resolvePolicyWithWaiverDirectories({
      repository,
      now: NOW,
    });
    const parseDiagnostic = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "CONFIG_PARSE_ERROR",
    );
    const serialized = JSON.stringify(result.diagnostics);

    expect(result.policy).toBeUndefined();
    expect(parseDiagnostic).toMatchObject({
      source: ".code-quality/waivers/invalid.json",
      message: "Invalid JSON document",
    });
    expect(parseDiagnostic?.line).toBeTypeOf("number");
    expect(parseDiagnostic?.column).toBeTypeOf("number");
    expect(serialized).not.toContain(sentinel);
  });

  test("bounds diagnostics from one large malformed policy document", async () => {
    const repository = await createRepository();
    const module = await import("../../../src/core/policy-diagnostics.js");
    const maximum: unknown = Reflect.get(
      module,
      "MAX_POLICY_DIAGNOSTICS_PER_DOCUMENT",
    );
    expect(maximum).toBeTypeOf("number");
    if (typeof maximum !== "number") {
      return;
    }
    const unknownProperties = Array.from(
      { length: maximum + 50 },
      (_, index) => `unknown${String(index)}: true`,
    ).join("\n");
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      `schemaVersion: "1"\nid: repository\nversion: 1\nrulePacks: [builtin:universal]\n${unknownProperties}\n`,
    );

    const result = await resolveEffectivePolicy({ repository });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "SCHEMA_INVALID",
      path: "/unknown0",
    });
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === "DIAGNOSTIC_LIMIT_EXCEEDED",
      ),
    ).toHaveLength(0);
  });

  test("does not report omitted document diagnostics at the exact limit", () => {
    const diagnostics = Array.from(
      { length: MAX_POLICY_DIAGNOSTICS_PER_DOCUMENT },
      (_, index) => ({
        code: "TEST_DIAGNOSTIC",
        source: "test",
        path: `/${String(index)}`,
        message: "test diagnostic",
      }),
    );

    const limited = limitPolicyDiagnostics(diagnostics, "test");

    expect(limited).toHaveLength(MAX_POLICY_DIAGNOSTICS_PER_DOCUMENT);
    expect(
      limited.some(
        (diagnostic) => diagnostic.code === "DIAGNOSTIC_LIMIT_EXCEEDED",
      ),
    ).toBe(false);
  });

  test("stops structural validation after the first invalid property", () => {
    const unknownProperties = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [
        `unknown${String(index).padStart(4, "0")}`,
        true,
      ]),
    );
    const target = {
      schemaVersion: "1",
      id: "repository",
      version: 1,
      rulePacks: ["builtin:universal"],
      ...unknownProperties,
    };
    let visitedUnknownProperties = 0;
    const observable = new Proxy(target, {
      getOwnPropertyDescriptor(current, property) {
        if (typeof property === "string" && property.startsWith("unknown")) {
          visitedUnknownProperties += 1;
        }
        return Reflect.getOwnPropertyDescriptor(current, property);
      },
    });

    const diagnostics = validatePolicyDocument(
      "profile",
      observable,
      "observable-profile",
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "SCHEMA_INVALID",
      path: "/unknown0000",
    });
    expect(visitedUnknownProperties).toBe(1);
  });

  test("reports a global limit only after a diagnostic is omitted", () => {
    const collector = new PolicyDiagnosticCollector();
    const diagnostics = Array.from(
      { length: MAX_POLICY_DIAGNOSTICS_PER_RESOLUTION },
      (_, index) => ({
        code: "TEST_DIAGNOSTIC",
        source: "test",
        path: `/${String(index)}`,
        message: "test diagnostic",
      }),
    );

    expect(collector.add(diagnostics)).toBe(true);
    expect(collector.toArray()).toHaveLength(
      MAX_POLICY_DIAGNOSTICS_PER_RESOLUTION,
    );
    expect(
      collector
        .toArray()
        .some((diagnostic) => diagnostic.code === "DIAGNOSTIC_LIMIT_EXCEEDED"),
    ).toBe(false);

    expect(
      collector.add([
        {
          code: "TEST_DIAGNOSTIC",
          source: "test",
          path: "/overflow",
          message: "overflow diagnostic",
        },
      ]),
    ).toBe(false);
    expect(collector.toArray()).toHaveLength(
      MAX_POLICY_DIAGNOSTICS_PER_RESOLUTION,
    );
    expect(
      collector
        .toArray()
        .filter(
          (diagnostic) => diagnostic.code === "DIAGNOSTIC_LIMIT_EXCEEDED",
        ),
    ).toHaveLength(1);
  });

  test("bounds duplicate-rule diagnostics and stops loading later packs", async () => {
    const repository = await createRepository();
    const module = await import("../../../src/core/policy-diagnostics.js");
    const maximum: unknown = Reflect.get(
      module,
      "MAX_POLICY_DIAGNOSTICS_PER_RESOLUTION",
    );
    expect(maximum).toBeTypeOf("number");
    if (typeof maximum !== "number") {
      return;
    }
    const packReferences = Array.from(
      { length: 8 },
      (_, index) => `repository:invalid-${String(index)}`,
    );
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      `schemaVersion: "1"\nid: repository\nversion: 1\nrulePacks:\n${packReferences.map((value) => `  - ${value}`).join("\n")}\n`,
    );
    const duplicateRules = Array.from({ length: 150 }, (_, index) => ({
      id: `CQ-TEST-${String(index).padStart(3, "0")}`,
      version: 1,
      title: `Test rule ${String(index)}`,
      rationale: "This rule exists to verify bounded duplicate diagnostics.",
      scope: "universal",
      triggers: ["source_change"],
      defaultSeverity: "P2",
      gateMode: "warn",
      detection: "deterministic",
      requiredEvidence: ["duplicate rule ID"],
      remediation: "Remove the duplicate rule definition before review.",
      verification: "Resolve the policy and confirm the duplicate is absent.",
      owner: "code-quality",
      examples: [],
      lifecycle: "active",
    }));
    for (let index = 0; index < packReferences.length; index += 1) {
      await writeRepositoryFile(
        repository,
        `.code-quality/rules/invalid-${String(index)}.yaml`,
        JSON.stringify({
          schemaVersion: "1",
          id: `invalid-${String(index)}`,
          version: 1,
          rules: duplicateRules,
        }),
      );
    }

    const loadedSources: string[] = [];
    const trustedRulePackLoader: TrustedRulePackLoader = async (request) => {
      loadedSources.push(request.source);
      return loadPolicyDocument(
        "rule",
        request.path,
        request.source,
        request.containmentRoot,
        request.budget,
      );
    };

    const result = await resolveEffectivePolicy(
      { repository },
      {
        trustedRulePackLoader,
      },
    );

    expect(result.policy).toBeUndefined();
    expect(loadedSources).toEqual(
      Array.from(
        { length: 5 },
        (_, index) => `.code-quality/rules/invalid-${String(index)}.yaml`,
      ),
    );
    expect(result.diagnostics.length).toBeLessThanOrEqual(maximum);
    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.code === "DIAGNOSTIC_LIMIT_EXCEEDED",
      ),
    ).toHaveLength(1);
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.source.includes("invalid-7.yaml"),
      ),
    ).toBe(false);
  });

  test("uses deterministic code-unit ordering for canonical Unicode keys", () => {
    const decomposed = "a\u0308";
    const canonical = canonicalizePolicy({
      ä: "composed",
      z: "latin-z",
      [decomposed]: "decomposed",
    });

    expect(canonical).toBe(
      `{"${decomposed}":"decomposed","z":"latin-z","ä":"composed"}`,
    );
  });

  test.each(["endpoint", "baseUrl", "headers", "token", "credentialEnv"])(
    "rejects unsafe repository provider field %s",
    async (field) => {
      const repository = await createRepository();
      const value =
        field === "headers" ? '{ Authorization: "secret" }' : '"unsafe"';
      await writeRepositoryFile(
        repository,
        ".code-quality/profile.yaml",
        `schemaVersion: "1"
id: repository
version: 1
rulePacks:
  - builtin:universal
provider:
  name: trusted-provider
  modelPolicy: reviewed-models
  ${field}: ${value}
`,
      );

      const result = await resolveEffectivePolicy({ repository });

      expect(result.policy).toBeUndefined();
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "SCHEMA_INVALID",
          source: ".code-quality/profile.yaml",
          path: `/provider/${field}`,
        }),
      );
    },
  );

  test("accepts only provider and model selections present in the trusted catalog", async () => {
    const repository = await createRepository();
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      `schemaVersion: "1"
id: repository
version: 1
rulePacks: [builtin:universal]
provider:
  name: trusted-provider
  model: reviewed-model
`,
    );

    const result = await resolveEffectivePolicy({
      repository,
      trustedProviders: [
        {
          name: "trusted-provider",
          allowedModels: ["reviewed-model"],
          allowedModelPolicies: ["reviewed-policy"],
        },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.policy?.provider).toEqual({
      name: "trusted-provider",
      model: "reviewed-model",
    });
  });

  test.each([
    ["absent catalog", undefined, "PROVIDER_CATALOG_REQUIRED"],
    [
      "unknown provider",
      [
        {
          name: "other-provider",
          allowedModels: ["reviewed-model"],
          allowedModelPolicies: [],
        },
      ],
      "PROVIDER_NOT_TRUSTED",
    ],
    [
      "disallowed model",
      [
        {
          name: "trusted-provider",
          allowedModels: ["other-model"],
          allowedModelPolicies: [],
        },
      ],
      "PROVIDER_MODEL_NOT_ALLOWED",
    ],
  ] as const)(
    "rejects provider selection with %s",
    async (_label, trustedProviders, expectedCode) => {
      const repository = await createRepository();
      await writeRepositoryFile(
        repository,
        ".code-quality/profile.yaml",
        `schemaVersion: "1"
id: repository
version: 1
rulePacks: [builtin:universal]
provider:
  name: trusted-provider
  model: reviewed-model
`,
      );

      const result = await resolveEffectivePolicy({
        repository,
        ...(trustedProviders === undefined ? {} : { trustedProviders }),
      });

      expect(result.policy).toBeUndefined();
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: expectedCode, path: "/provider" }),
      );
    },
  );

  test("does not treat a user-default provider selection as trusted", async () => {
    const repository = await createRepository();

    const result = await resolveEffectivePolicy({
      repository,
      userDefaults: {
        provider: { name: "invented-provider", modelPolicy: "invented-policy" },
      },
    });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "PROVIDER_CATALOG_REQUIRED" }),
    );
  });

  test("rejects duplicate rule IDs across selected rule packs", async () => {
    const repository = await createRepository();
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      `schemaVersion: "1"
id: repository
version: 1
rulePacks:
  - builtin:universal
  - repository:duplicate
`,
    );
    await writeRepositoryFile(
      repository,
      ".code-quality/rules/duplicate.yaml",
      `schemaVersion: "1"
id: duplicate
version: 1
rules:
  - id: CQ-READ-001
    version: 1
    title: Duplicate readability rule
    rationale: Duplicates must not make precedence ambiguous.
    scope: universal
    triggers: [source_change]
    defaultSeverity: P2
    gateMode: block
    detection: hybrid
    requiredEvidence: [source_range]
    remediation: Remove the duplicate rule definition.
    verification: Resolve the policy again.
    owner: code-quality
    examples: []
    lifecycle: active
`,
    );

    const result = await resolveEffectivePolicy({ repository });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_RULE_ID",
        path: "/rules/CQ-READ-001",
      }),
    );
  });

  test("rejects missing rule-pack references instead of falling back", async () => {
    const repository = await createRepository();
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      `schemaVersion: "1"
id: repository
version: 1
rulePacks: [repository:missing]
`,
    );

    const result = await resolveEffectivePolicy({ repository });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "RULE_PACK_NOT_FOUND",
        source: ".code-quality/rules/missing.yaml",
      }),
    );
  });

  test("rejects a rule override that does not reference a selected rule", async () => {
    const repository = await createRepository();
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      `schemaVersion: "1"
id: repository
version: 1
rulePacks: [builtin:universal]
ruleOverrides:
  CQ-MISSING-001:
    enabled: false
`,
    );

    const result = await resolveEffectivePolicy({ repository });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "RULE_OVERRIDE_NOT_FOUND",
        source: ".code-quality/profile.yaml",
        path: "/ruleOverrides/CQ-MISSING-001",
      }),
    );
  });

  test("applies deterministic precedence and preserves safety invariants", async () => {
    const repository = await createRepository();
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      `schemaVersion: "1"
id: repository
version: 1
rulePacks: [builtin:universal]
budgets:
  maxFiles: 150
  maxProviderConcurrency: 4
provider:
  name: repository-provider
  modelPolicy: reviewed
`,
    );

    const result = await resolveEffectivePolicy({
      repository,
      trustedProviders: [
        {
          name: "invocation-provider",
          allowedModels: [],
          allowedModelPolicies: ["reviewed"],
        },
      ],
      userDefaults: {
        budgets: { maxFiles: 180 },
        provider: { name: "user-provider" },
      },
      overrides: {
        budgets: { maxFiles: 125, maxProviderConcurrency: 9 },
        provider: { name: "invocation-provider" },
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.policy).toMatchObject({
      budgets: {
        maxFiles: 125,
        maxProviderConcurrency: 2,
      },
      provider: {
        name: "invocation-provider",
        modelPolicy: "reviewed",
      },
    });
    expect(result.policy?.resolution).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/budgets/maxFiles",
          source: "invocation",
        }),
        expect.objectContaining({
          path: "/budgets/maxProviderConcurrency",
          source: "safety-invariants",
        }),
      ]),
    );
  });

  test("discovers valid waiver files in stable order and includes their hashes", async () => {
    const repository = await createRepository();
    await writeRepositoryFile(
      repository,
      ".code-quality/waivers/z-last.yaml",
      waiverYaml("waiver-z-last"),
    );
    await writeRepositoryFile(
      repository,
      ".code-quality/waivers/a-first.json",
      JSON.stringify({
        schemaVersion: "1",
        id: "waiver-a-first",
        ruleId: "CQ-READ-003",
        ruleVersion: { minimum: 1, maximum: 1 },
        repository: "StephenYgg/example",
        scope: { paths: ["src/export/**"] },
        reason: "The behavior remains stable during a bounded migration.",
        riskAcceptance: "The owner accepts this temporary readability risk.",
        approver: "engineering-director",
        owner: "export-team",
        compensatingControls: [
          "Characterization tests cover every current outcome.",
        ],
        trackingIssue: "https://example.invalid/issues/123",
        createdAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-08-01T00:00:00.000Z",
      }),
    );
    await writeRepositoryFile(
      repository,
      ".code-quality/waivers/ignored.txt",
      "not a waiver",
    );

    const result = await resolvePolicyWithWaiverDirectories({
      repository,
      now: NOW,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.policy?.waivers.map((waiver) => waiver.id)).toEqual([
      "waiver-a-first",
      "waiver-z-last",
    ]);
    expect(
      result.sources
        .filter((source) => source.kind === "waiver")
        .map((source) => source.source),
    ).toEqual([
      ".code-quality/waivers/a-first.json",
      ".code-quality/waivers/z-last.yaml",
    ]);
  });

  test("invalidates policy resolution for an expired discovered waiver", async () => {
    const repository = await createRepository();
    await writeRepositoryFile(
      repository,
      ".code-quality/waivers/expired.yaml",
      waiverYaml("waiver-expired").replace(
        "2026-08-01T00:00:00.000Z",
        "2026-07-19T11:59:59.000Z",
      ),
    );

    const result = await resolvePolicyWithWaiverDirectories({
      repository,
      now: NOW,
    });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "WAIVER_EXPIRED",
        source: ".code-quality/waivers/expired.yaml",
      }),
    );
  });

  test("associates duplicate waiver diagnostics with the second valid source", async () => {
    const repository = await createRepository();
    await writeRepositoryFile(
      repository,
      ".code-quality/waivers/a-invalid.yaml",
      `${waiverYaml("waiver-invalid")}unexpected: true\n`,
    );
    await writeRepositoryFile(
      repository,
      ".code-quality/waivers/b-first.yaml",
      waiverYaml("waiver-duplicate"),
    );
    await writeRepositoryFile(
      repository,
      ".code-quality/waivers/c-second.yaml",
      waiverYaml("waiver-duplicate"),
    );

    const result = await resolvePolicyWithWaiverDirectories({
      repository,
      now: NOW,
    });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_WAIVER_ID",
        source: ".code-quality/waivers/c-second.yaml",
      }),
    );
  });

  test("rejects a waiver file symlink that escapes repository containment", async () => {
    const repository = await createRepository();
    const outside = await mkdtemp(join(tmpdir(), "cq-waiver-outside-"));
    temporaryDirectories.push(outside);
    const outsideWaiver = join(outside, "waiver.yaml");
    await writeFile(outsideWaiver, waiverYaml("waiver-outside"), "utf8");
    await mkdir(join(repository, ".code-quality", "waivers"), {
      recursive: true,
    });
    await symlink(
      outsideWaiver,
      join(repository, ".code-quality", "waivers", "escape.yaml"),
    );

    const result = await resolvePolicyWithWaiverDirectories({
      repository,
      now: NOW,
    });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONFIG_PATH_ESCAPE",
        source: ".code-quality/waivers/escape.yaml",
      }),
    );
  });

  test("rejects more than 1000 discovered waiver files before parsing them", async () => {
    const repository = await createRepository();
    for (let index = 0; index < 1_001; index += 1) {
      await writeRepositoryFile(
        repository,
        `.code-quality/waivers/${String(index).padStart(4, "0")}.yaml`,
        "not: parsed\n",
      );
    }

    const result = await resolvePolicyWithWaiverDirectories({
      repository,
      now: NOW,
    });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "WAIVER_FILE_LIMIT_EXCEEDED" }),
    );
  });

  test("bounds inspected directory entries even when none are waiver files", async () => {
    const repository = await createRepository();
    const module = await import("../../../src/core/waiver-discovery.js");
    const maximumEntries: unknown = Reflect.get(
      module,
      "MAX_WAIVER_DIRECTORY_ENTRIES",
    );
    expect(maximumEntries).toBeTypeOf("number");
    if (typeof maximumEntries !== "number") {
      return;
    }
    for (let index = 0; index <= maximumEntries; index += 1) {
      await writeRepositoryFile(
        repository,
        `.code-quality/waivers/ignored-${String(index).padStart(4, "0")}.txt`,
        "ignored\n",
      );
    }

    const result = await resolvePolicyWithWaiverDirectories({
      repository,
      now: NOW,
    });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "WAIVER_DIRECTORY_ENTRY_LIMIT_EXCEEDED",
      }),
    );
  });

  test("shares the inspected-entry budget across waiver directories", async () => {
    const repository = await createRepository();
    const module = await import("../../../src/core/waiver-discovery.js");
    const maximumEntries: unknown = Reflect.get(
      module,
      "MAX_WAIVER_DIRECTORY_ENTRIES",
    );
    expect(maximumEntries).toBeTypeOf("number");
    if (typeof maximumEntries !== "number") {
      return;
    }
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      'schemaVersion: "1"\nid: repository\nversion: 1\nrulePacks: [builtin:universal]\nwaiverLocations: [waivers-a, waivers-b]\n',
    );
    for (let index = 0; index <= maximumEntries; index += 1) {
      const directory = index % 2 === 0 ? "waivers-a" : "waivers-b";
      await writeRepositoryFile(
        repository,
        `${directory}/ignored-${String(index).padStart(4, "0")}.txt`,
        "ignored\n",
      );
    }

    const result = await resolvePolicyWithWaiverDirectories({
      repository,
      now: NOW,
    });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "WAIVER_DIRECTORY_ENTRY_LIMIT_EXCEEDED",
      }),
    );
  });

  test.each(["json", "yaml"] as const)(
    "rejects %s structured input deeper than the hard nesting limit",
    async (format) => {
      const repository = await createRepository();
      const module = await import("../../../src/core/config.js");
      const maximumDepth: unknown = Reflect.get(module, "MAX_STRUCTURED_DEPTH");
      expect(maximumDepth).toBeTypeOf("number");
      if (typeof maximumDepth !== "number") {
        return;
      }
      let data: unknown = "leaf";
      for (let index = 0; index <= maximumDepth; index += 1) {
        data = { child: data };
      }
      const path = join(repository, `deep.${format}`);
      const content =
        format === "json"
          ? JSON.stringify(data)
          : `${Array.from(
              { length: maximumDepth + 1 },
              (_, index) => `${"  ".repeat(index)}child:`,
            ).join("\n")}\n${"  ".repeat(maximumDepth + 1)}leaf\n`;
      await writeFile(path, content, "utf8");

      await expect(
        module.loadStructuredFile(path, {
          containmentRoot: repository,
          source: `deep.${format}`,
          budget: module.createStructuredReadBudget(),
        }),
      ).rejects.toMatchObject({
        code: "CONFIG_DEPTH_EXCEEDED",
        source: `deep.${format}`,
      });
    },
  );

  test("rejects invalid budgets without silently using defaults", async () => {
    const repository = await createRepository();
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      `schemaVersion: "1"
id: repository
version: 1
rulePacks: [builtin:universal]
budgets:
  maxFiles: 0
`,
    );

    const result = await resolveEffectivePolicy({ repository });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_INVALID",
        source: ".code-quality/profile.yaml",
        path: "/budgets/maxFiles",
      }),
    );
  });

  test("enforces the one MiB per-file structured input limit", async () => {
    const repository = await createRepository();
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      `# ${"x".repeat(1024 * 1024)}\nschemaVersion: "1"\n`,
    );

    const result = await resolveEffectivePolicy({ repository });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "CONFIG_FILE_TOO_LARGE" }),
    );
  });

  test("enforces the eight MiB aggregate policy-resolution limit", async () => {
    const repository = await createRepository();
    const references = Array.from(
      { length: 9 },
      (_, index) => `repository:pack-${String(index + 1)}`,
    );
    await writeRepositoryFile(
      repository,
      ".code-quality/profile.yaml",
      `schemaVersion: "1"
id: repository
version: 1
rulePacks:
${references.map((reference) => `  - ${reference}`).join("\n")}
`,
    );
    await Promise.all(
      references.map(async (reference, index) => {
        const suffix = String(index + 1).padStart(3, "0");
        await writeRepositoryFile(
          repository,
          `.code-quality/rules/${reference.slice("repository:".length)}.yaml`,
          `# ${"x".repeat(940_000)}
schemaVersion: "1"
id: pack-${String(index + 1)}
version: 1
rules:
  - id: CQ-CUSTOM-${suffix}
    version: 1
    title: Bounded aggregate fixture
    rationale: Aggregate configuration bytes must be bounded across all selected packs.
    scope: universal
    triggers: [source_change]
    defaultSeverity: P3
    gateMode: advisory
    detection: deterministic
    requiredEvidence: [configuration bytes]
    remediation: Select a smaller bounded set of rule packs.
    verification: Resolve the reduced policy within its byte budget.
    owner: code-quality
    examples: []
    lifecycle: active
`,
        );
      }),
    );

    const result = await resolveEffectivePolicy({ repository });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "CONFIG_RESOLUTION_TOO_LARGE" }),
    );
  });

  test("rejects a repository profile symlink that escapes containment", async () => {
    const repository = await createRepository();
    const outside = await mkdtemp(join(tmpdir(), "cq-policy-outside-"));
    temporaryDirectories.push(outside);
    const outsideProfile = join(outside, "profile.yaml");
    await writeFile(
      outsideProfile,
      'schemaVersion: "1"\nid: outside\nversion: 1\nrulePacks: [builtin:universal]\n',
      "utf8",
    );
    await mkdir(join(repository, ".code-quality"), { recursive: true });
    await symlink(
      outsideProfile,
      join(repository, ".code-quality", "profile.yaml"),
    );

    const result = await resolveEffectivePolicy({ repository });

    expect(result.policy).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "CONFIG_PATH_ESCAPE" }),
    );
  });

  test("validates every strict machine contract and rejects unknown keys", () => {
    const finding = {
      schemaVersion: "1",
      id: "finding-1",
      ruleId: "CQ-READ-001",
      ruleVersion: 1,
      title: "Oversized function",
      severity: "P2",
      confidence: "high",
      status: "confirmed",
      disposition: "new",
      locations: [{ path: "src/export.ts", startLine: 1, endLine: 310 }],
      trigger: "A new function exceeds the hard threshold.",
      actualBehavior: "The function mixes unrelated phases.",
      expectedBehavior: "Business phases are independently reviewable.",
      impact: "Changes require broad regression checks.",
      evidence: ["AST span is 310 lines."],
      remediation: "Split by coherent business phase.",
      verification: ["Run focused behavior tests."],
      reviewStage: "readability",
      provider: "deterministic",
      model: "none",
      timestamps: { createdAt: "2026-07-19T00:00:00.000Z" },
    };

    expect(validatePolicyDocument("finding", finding, "finding.json")).toEqual(
      [],
    );
    expect(
      validatePolicyDocument(
        "finding",
        { ...finding, unexpected: true },
        "finding.json",
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_INVALID",
        path: "/unexpected",
      }),
    );
  });

  test.each([
    [
      "score-model" as const,
      {
        schemaVersion: "1",
        ...DEFAULT_SCORE_MODEL,
      },
    ],
    [
      "run" as const,
      {
        schemaVersion: "1",
        id: "run-1",
        input: {
          kind: "worktree",
          scope: "change",
          repository: "StephenYgg/example",
          head: "synthetic-head",
          contentHash: "a".repeat(64),
        },
        policyHash: "b".repeat(64),
        gate: "PASS",
        findingIds: [],
        timestamps: { startedAt: "2026-07-19T00:00:00.000Z" },
      },
    ],
  ])("validates strict %s documents", (kind, document) => {
    expect(validatePolicyDocument(kind, document, `${kind}.json`)).toEqual([]);
    expect(
      validatePolicyDocument(
        kind,
        { ...document, unexpected: true },
        `${kind}.json`,
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_INVALID",
        path: "/unexpected",
      }),
    );
  });
});
