import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DataClassification } from "../core/egress.js";
import { resolveEffectivePolicy } from "../core/policy.js";
import type { PolicyQualityCommand } from "../core/policy-types.js";
import type { ScoreModel } from "../core/scoring.js";
import {
  loadUserConfig,
  userConfigToTrustedCatalog,
} from "../core/user-config.js";
import { materializeProfileScoreModel } from "./profile-score-model.js";

export interface BasePolicyBinding {
  readonly policyHash: string;
  readonly dataClassification: DataClassification;
  readonly providerName?: string;
  readonly model?: string;
  readonly baseWorktree: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly headPolicyPathsIgnored: readonly string[];
  readonly diagnostics: readonly string[];
  readonly scoreModel: ScoreModel;
  readonly qualityCommands: readonly PolicyQualityCommand[];
}

const HEAD_POLICY_PATHS = [
  ".code-quality/profile.yaml",
  "profiles/default.yaml",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
] as const;

export class BasePolicyBindingError extends Error {
  constructor(readonly diagnostics: readonly string[]) {
    super("Authoritative base policy is invalid");
    this.name = "BasePolicyBindingError";
  }
}

/**
 * Resolves effective policy exclusively from the base revision worktree.
 * Head-side policy/instruction files may exist but must not become active.
 * Provider credentials remain outside the repository (trusted user config).
 */
export async function bindBasePolicy(options: {
  readonly baseWorktree: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly headWorktree?: string;
  readonly configPath?: string;
  readonly profileName?: string;
}): Promise<BasePolicyBinding> {
  const diagnostics: string[] = [];
  const headPolicyPathsIgnored: string[] = [];

  if (options.headWorktree !== undefined) {
    for (const relative of HEAD_POLICY_PATHS) {
      const headPath = join(options.headWorktree, relative);
      try {
        await access(headPath);
        // Compare with base when both exist; always mark as non-active for head.
        const basePath = join(options.baseWorktree, relative);
        let changed = true;
        try {
          const [headBody, baseBody] = await Promise.all([
            readFile(headPath, "utf8"),
            readFile(basePath, "utf8"),
          ]);
          changed = headBody !== baseBody;
        } catch {
          changed = true;
        }
        if (changed) {
          headPolicyPathsIgnored.push(relative);
          diagnostics.push(
            `Ignoring head revision policy/instruction path ${relative}; base revision remains authoritative`,
          );
        }
      } catch {
        // missing on head is fine
      }
    }
  }

  let trustedProviders;
  try {
    const userConfig = await loadUserConfig({
      ...(options.configPath === undefined ? {} : { path: options.configPath }),
    });
    trustedProviders = userConfigToTrustedCatalog(userConfig);
  } catch (error) {
    diagnostics.push(
      error instanceof Error
        ? error.message
        : "Trusted user config unavailable for base-policy binding",
    );
  }

  const resolved = await resolveEffectivePolicy({
    repository: options.baseWorktree,
    ...(options.profileName === undefined
      ? {}
      : { profileName: options.profileName }),
    ...(trustedProviders === undefined ? {} : { trustedProviders }),
  });

  if (resolved.policy === undefined || resolved.policyHash === undefined) {
    diagnostics.push(
      ...resolved.diagnostics.map((item) => `${item.code}: ${item.message}`),
    );
    throw new BasePolicyBindingError(Object.freeze(diagnostics));
  }

  const scoreModel = materializeProfileScoreModel(
    resolved.policy.scoreModel,
    resolved.policyHash,
  );
  return {
    policyHash: resolved.policyHash,
    dataClassification: resolved.policy.dataClassification ?? "internal",
    ...(resolved.policy.provider?.name === undefined
      ? {}
      : { providerName: resolved.policy.provider.name }),
    ...(resolved.policy.provider?.model === undefined
      ? {}
      : { model: resolved.policy.provider.model }),
    baseWorktree: options.baseWorktree,
    baseSha: options.baseSha,
    headSha: options.headSha,
    headPolicyPathsIgnored: Object.freeze(headPolicyPathsIgnored),
    diagnostics: Object.freeze(diagnostics),
    scoreModel,
    qualityCommands: Object.freeze(
      (resolved.policy.qualityCommands ?? []).map((command) =>
        Object.freeze({ ...command, argv: Object.freeze([...command.argv]) }),
      ),
    ),
  };
}
