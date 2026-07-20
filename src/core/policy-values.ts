import { createHash } from "node:crypto";

import type { StructuredSource } from "./config.js";
import { compareCodeUnits } from "./deterministic-order.js";
import type { PolicyLayer, PolicySource } from "./policy-types.js";

export function canonicalizePolicy(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizePolicy(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    compareCodeUnits(left, right),
  );
  return `{${entries
    .map(
      ([key, entry]) => `${JSON.stringify(key)}:${canonicalizePolicy(entry)}`,
    )
    .join(",")}}`;
}

export function policySha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function inlinePolicySource(
  kind: PolicySource["kind"],
  source: string,
  value: unknown,
  precedence: number,
): PolicySource {
  const canonical = canonicalizePolicy(value);
  return {
    kind,
    source,
    sha256: policySha256(canonical),
    bytes: Buffer.byteLength(canonical),
    precedence,
  };
}

export function filePolicySource(
  kind: PolicySource["kind"],
  structured: StructuredSource,
  precedence: number,
): PolicySource {
  return {
    kind,
    source: structured.source,
    sha256: structured.sha256,
    bytes: structured.bytes,
    precedence,
  };
}

export function deepFreezePolicy<T>(value: T): T {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return value;
  }
  const pending: object[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const key of Object.keys(current)) {
      const child: unknown = Reflect.get(current, key);
      if (
        (typeof child === "object" || typeof child === "function") &&
        child !== null
      ) {
        pending.push(child);
      }
    }
    Object.freeze(current);
  }
  return value;
}

function cloneRecord<T>(
  value: Readonly<Record<string, T>> | undefined,
): Record<string, T> {
  return value === undefined ? {} : { ...value };
}

function cloneRuleOverrides(
  value: PolicyLayer["ruleOverrides"],
): Record<string, NonNullable<PolicyLayer["ruleOverrides"]>[string]> {
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([key, ruleOverride]) => [
      key,
      { ...ruleOverride },
    ]),
  );
}

function recordOrigins(
  layer: PolicyLayer,
  source: string,
  origins: Map<string, string>,
): void {
  const scalarPaths: readonly [string, unknown][] = [
    ["/rulePacks", layer.rulePacks],
    ["/dataClassification", layer.dataClassification],
    ["/provider/name", layer.provider?.name],
    ["/provider/modelPolicy", layer.provider?.modelPolicy],
    ["/provider/model", layer.provider?.model],
    ["/waiverLocations", layer.waiverLocations],
    ["/scoreModel/id", layer.scoreModel?.id],
    ["/criticalPaths", layer.criticalPaths],
    ["/riskTriggers", layer.riskTriggers],
    ["/qualityCommands", layer.qualityCommands],
    ["/peerAgentDocuments", layer.peerAgentDocuments],
  ];
  for (const [path, value] of scalarPaths) {
    if (value !== undefined) {
      origins.set(path, source);
    }
  }
  const nestedKeys: readonly [string, object | undefined][] = [
    ["/budgets", layer.budgets],
    ["/gate", layer.gate],
    ["/ruleOverrides", layer.ruleOverrides],
    ["/scoreModel/majorWeights", layer.scoreModel?.majorWeights],
    ["/scoreModel/minorWeights", layer.scoreModel?.minorWeights],
  ];
  for (const [prefix, values] of nestedKeys) {
    for (const key of Object.keys(values ?? {})) {
      origins.set(`${prefix}/${key}`, source);
    }
  }
}

export function mergePolicyLayer(
  target: PolicyLayer,
  layer: PolicyLayer,
  source: string,
  origins: Map<string, string>,
): PolicyLayer {
  const result: PolicyLayer = {
    ...target,
    ...(layer.rulePacks === undefined
      ? {}
      : { rulePacks: [...layer.rulePacks] }),
    ...(layer.dataClassification === undefined
      ? {}
      : { dataClassification: layer.dataClassification }),
    ...(layer.provider === undefined
      ? {}
      : { provider: { ...target.provider, ...layer.provider } }),
    ...(layer.budgets === undefined
      ? {}
      : { budgets: { ...target.budgets, ...layer.budgets } }),
    ...(layer.gate === undefined
      ? {}
      : { gate: { ...target.gate, ...layer.gate } }),
    ...(layer.ruleOverrides === undefined
      ? {}
      : {
          ruleOverrides: {
            ...cloneRuleOverrides(target.ruleOverrides),
            ...cloneRuleOverrides(layer.ruleOverrides),
          },
        }),
    ...(layer.waiverLocations === undefined
      ? {}
      : { waiverLocations: [...layer.waiverLocations] }),
    ...(layer.scoreModel === undefined
      ? {}
      : {
          scoreModel: {
            ...target.scoreModel,
            ...layer.scoreModel,
            majorWeights: {
              ...cloneRecord(target.scoreModel?.majorWeights),
              ...cloneRecord(layer.scoreModel.majorWeights),
            },
            minorWeights: {
              ...cloneRecord(target.scoreModel?.minorWeights),
              ...cloneRecord(layer.scoreModel.minorWeights),
            },
          },
        }),
    ...(layer.criticalPaths === undefined
      ? {}
      : { criticalPaths: [...layer.criticalPaths] }),
    ...(layer.riskTriggers === undefined
      ? {}
      : { riskTriggers: [...layer.riskTriggers] }),
    ...(layer.qualityCommands === undefined
      ? {}
      : {
          qualityCommands: layer.qualityCommands.map((command) => ({
            ...command,
            argv: [...command.argv],
          })),
        }),
    ...(layer.peerAgentDocuments === undefined
      ? {}
      : { peerAgentDocuments: [...layer.peerAgentDocuments] }),
  };
  recordOrigins(layer, source, origins);
  return result;
}

export function applySafetyInvariants(
  layer: PolicyLayer,
  origins: Map<string, string>,
): PolicyLayer {
  const requestedConcurrency = layer.budgets?.maxProviderConcurrency ?? 2;
  const requestedAttempts = layer.budgets?.maxProviderAttempts ?? 16;
  const boundedConcurrency = Math.min(requestedConcurrency, 2);
  const boundedAttempts = Math.min(requestedAttempts, 16);
  if (boundedConcurrency !== requestedConcurrency) {
    origins.set("/budgets/maxProviderConcurrency", "safety-invariants");
  }
  if (boundedAttempts !== requestedAttempts) {
    origins.set("/budgets/maxProviderAttempts", "safety-invariants");
  }
  return {
    ...layer,
    budgets: {
      ...layer.budgets,
      maxProviderConcurrency: boundedConcurrency,
      maxProviderAttempts: boundedAttempts,
    },
  };
}
