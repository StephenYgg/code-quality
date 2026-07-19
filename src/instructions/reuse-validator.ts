import { dirname, isAbsolute, resolve } from "node:path";

import {
  agentDiagnostic as diagnostic,
  type DiagnosticLocation,
} from "../core/agent-diagnostic.js";
import {
  BoundedDiagnosticCollector,
  DEFAULT_MAX_DIAGNOSTICS,
  HARD_MAX_DIAGNOSTICS,
} from "../core/bounded-diagnostics.js";
import {
  AGENT_DOCUMENT_RULE_ID,
  type ValidationDiagnostic,
  type ValidationGate,
} from "../core/validation.js";
import {
  isInsideRepository,
  readInstruction,
  resolveInstructionRealPath,
  type ReadBudget,
  type ReadInstruction,
} from "./bounded-reader.js";
import {
  discoverInstructionScopes,
  type DiscoveryOptions,
  type InstructionScope,
} from "./discovery.js";
import type { ParsedInstructionMarkdown } from "./markdown.js";
import { findReferenceCycleComponents } from "./reference-graph.js";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 16 * 1024 * 1024;
const HARD_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ValidateAgentInstructionsOptions extends DiscoveryOptions {
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

export interface AgentInstructionValidationReport {
  readonly ruleId: typeof AGENT_DOCUMENT_RULE_ID;
  readonly gate: ValidationGate;
  readonly repository: string;
  readonly scopesChecked: number;
  readonly filesChecked: number;
  readonly diagnostics: readonly ValidationDiagnostic[];
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  if (resolved > hardMaximum) {
    throw new TypeError(`${label} cannot exceed ${String(hardMaximum)}`);
  }
  return resolved;
}

function stripReferenceSuffix(reference: string): string {
  return reference.split(/[?#]/u, 1)[0] ?? reference;
}

function canonicalReferenceKind(
  references: readonly string[],
): "same_scope" | "wrong_scope" | "missing" {
  const canonicalReferences = references
    .map((reference) => reference.replaceAll("\\", "/"))
    .filter((reference) => /(?:^|[/:])AGENTS\.md$/u.test(reference));
  if (
    canonicalReferences.some(
      (reference) => reference === "AGENTS.md" || reference === "./AGENTS.md",
    )
  ) {
    return "same_scope";
  }
  return canonicalReferences.length > 0 ? "wrong_scope" : "missing";
}

function sectionKind(
  title: string,
  peerFileName: string,
): "canonical" | "delta" | "unknown" {
  const normalized = title.normalize("NFKC").toLocaleLowerCase("en-US").trim();
  if (
    /^(?:canonical|shared) (?:instructions|rules)$/u.test(normalized) ||
    /^(?:统一|共性|共享)(?:指令|规则|约束)$/u.test(normalized)
  ) {
    return "canonical";
  }
  const peerName = peerFileName
    .replace(/\.md$/iu, "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  const specificPrefix =
    /^(?:tool|agent)-specific\b/u.test(normalized) ||
    normalized.startsWith(`${peerName}-specific`);
  if (
    specificPrefix ||
    /^(?:工具|智能体|agent|tool)(?:特定|专属)(?:增量|指令|规则|约束)$/u.test(
      normalized,
    )
  ) {
    return "delta";
  }
  return "unknown";
}

function locationOf(
  value: { readonly line: number; readonly column: number } | undefined,
): DiagnosticLocation | undefined {
  return value === undefined
    ? undefined
    : { line: value.line, column: value.column };
}

function unscopedPeerContentLocation(
  parsed: ParsedInstructionMarkdown,
  peerFileName: string,
): DiagnosticLocation | undefined {
  const sectionKinds = new Map(
    parsed.headings
      .filter((heading) => heading.depth === 2)
      .map((heading) => [
        heading.title,
        sectionKind(heading.title, peerFileName),
      ]),
  );
  const unknownHeading = parsed.headings.find(
    (heading) =>
      heading.depth === 2 && sectionKinds.get(heading.title) === "unknown",
  );
  if (unknownHeading !== undefined) {
    return locationOf(unknownHeading);
  }
  const pointerParagraph = parsed.canonicalDirectiveLocation;
  const canonicalContentParagraph = parsed.paragraphs.find((paragraph) => {
    const inCanonicalSection =
      paragraph.section !== undefined &&
      sectionKinds.get(paragraph.section) === "canonical";
    if (!inCanonicalSection && paragraph !== pointerParagraph) {
      return false;
    }
    return paragraph.text
      .normalize("NFKC")
      .replace(/agents\.md/giu, "AGENTS_MD")
      .split(/[.!?;。！？；\n]+/u)
      .map((clause) => clause.trim())
      .filter((clause) => clause !== "")
      .some((clause) => {
        const allowedAgentClause =
          /AGENTS_MD/u.test(clause) &&
          !/AGENTS_MD.{0,50}\band\s+(?:always\s+)?(?:use|avoid|prefer|require|write|format|name|test)\b/iu.test(
            clause,
          );
        return (
          !allowedAgentClause &&
          !(
            paragraph === pointerParagraph &&
            !/AGENTS_MD/u.test(clause) &&
            (/\bread\b/iu.test(clause) ||
              /^\s*(?:you\s+)?(?:(?:must|should)\s+)?(?:follow|obey)\s+(?:it|them|these|those|the\s+(?:rules|instructions))\b/iu.test(
                clause,
              ) ||
              /^\s*(?:you\s+)?(?:(?:must|should)\s+)?comply with\s+(?:it|them|these|those|the\s+(?:rules|instructions))\b/iu.test(
                clause,
              ))
          ) &&
          !/\b(?:do not|must not|never)\s+(?:copy|duplicate|repeat)\b.{0,80}\bshared\s+(?:rules|instructions)\b/iu.test(
            clause,
          ) &&
          !/(?:不得|不能|不要).{0,30}(?:复制|重复).{0,30}(?:共性|共享)(?:规则|指令|约束)/u.test(
            clause,
          )
        );
      });
  });
  if (canonicalContentParagraph !== undefined) {
    return locationOf(canonicalContentParagraph);
  }
  const unsectionedParagraphs = parsed.paragraphs.filter(
    (paragraph) => paragraph.section === undefined,
  );
  if (unsectionedParagraphs.length > 1) {
    return locationOf(unsectionedParagraphs[1]);
  }
  return locationOf(
    parsed.paragraphs.find(
      (paragraph) =>
        paragraph.section !== undefined &&
        sectionKinds.get(paragraph.section) === "unknown",
    ),
  );
}

function copiedPolicyDiagnostics(
  canonical: ReadInstruction,
  peer: ReadInstruction,
): ValidationDiagnostic[] {
  const canonicalBlocks = new Set(
    canonical.parsed.normalizedBlocks.map((block) => block.value),
  );
  const copiedBlock = peer.parsed.normalizedBlocks.find((block) =>
    canonicalBlocks.has(block.value),
  );
  return copiedBlock !== undefined
    ? [
        diagnostic(
          "COPIED_SHARED_POLICY",
          "policy",
          peer.file.relativePath,
          "Peer document repeats a nontrivial normalized policy block from AGENTS.md",
          canonical.file.relativePath,
          locationOf(copiedBlock),
        ),
      ]
    : [];
}

function cycleComponents(
  repository: string,
  instructions: ReadonlyMap<string, ReadInstruction>,
): Map<string, ReadonlySet<string>> {
  const graph = new Map<string, string[]>();
  for (const [absolutePath, instruction] of instructions) {
    const targets = instruction.parsed.linkTargets
      .map(stripReferenceSuffix)
      .filter((target) => target !== "" && !isAbsolute(target))
      .map((target) => resolve(dirname(absolutePath), target))
      .filter(
        (target) =>
          isInsideRepository(repository, target) && instructions.has(target),
      );
    graph.set(absolutePath, [...new Set(targets)]);
  }
  return findReferenceCycleComponents(graph);
}

function cyclicReferenceLocation(
  repository: string,
  absolutePath: string,
  instruction: ReadInstruction,
  cyclic: ReadonlySet<string>,
): DiagnosticLocation | undefined {
  const evidence = instruction.parsed.linkTargetLocations.find((link) => {
    const target = stripReferenceSuffix(link.target);
    if (target === "" || isAbsolute(target)) {
      return false;
    }
    const resolvedTarget = resolve(dirname(absolutePath), target);
    return (
      isInsideRepository(repository, resolvedTarget) &&
      cyclic.has(resolvedTarget)
    );
  });
  return locationOf(evidence);
}

function policyDiagnostics(
  scope: InstructionScope,
  canonical: ReadInstruction,
  peer: ReadInstruction,
): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const location = locationOf(
    peer.parsed.paragraphs.find(
      (paragraph) => canonicalReferenceKind(paragraph.references) !== "missing",
    ) ?? peer.parsed.paragraphs[0],
  );
  const referenceKind = canonicalReferenceKind(peer.parsed.references);
  if (referenceKind === "missing") {
    diagnostics.push(
      diagnostic(
        "MISSING_CANONICAL_REFERENCE",
        "policy",
        peer.file.relativePath,
        "Peer document does not reference the same-scope AGENTS.md",
        canonical.file.relativePath,
        location,
      ),
    );
  } else if (referenceKind === "wrong_scope") {
    diagnostics.push(
      diagnostic(
        "WRONG_CANONICAL_SCOPE",
        "policy",
        peer.file.relativePath,
        `Peer document points outside its ${scope.directory} instruction scope`,
        canonical.file.relativePath,
        location,
      ),
    );
  } else if (!peer.parsed.canonicalDirective) {
    diagnostics.push(
      diagnostic(
        "MISSING_CANONICAL_DIRECTIVE",
        "policy",
        peer.file.relativePath,
        "Peer document references AGENTS.md without requiring the Agent to read and follow it",
        canonical.file.relativePath,
        location,
      ),
    );
  }

  if (peer.parsed.explicitCanonicalConflict) {
    diagnostics.push(
      diagnostic(
        "EXPLICIT_CANONICAL_CONFLICT",
        "policy",
        peer.file.relativePath,
        "Peer document explicitly weakens or overrides AGENTS.md",
        canonical.file.relativePath,
        locationOf(peer.parsed.explicitCanonicalConflictLocation) ?? location,
      ),
    );
  }

  const unscopedLocation = unscopedPeerContentLocation(
    peer.parsed,
    peer.file.name,
  );
  if (unscopedLocation !== undefined) {
    diagnostics.push(
      diagnostic(
        "UNSCOPED_PEER_CONTENT",
        "policy",
        peer.file.relativePath,
        "Peer document contains a section that is not a canonical pointer or a clearly named tool-specific delta",
        canonical.file.relativePath,
        unscopedLocation,
      ),
    );
  }

  diagnostics.push(...copiedPolicyDiagnostics(canonical, peer));
  return diagnostics;
}

function gateFor(diagnostics: readonly ValidationDiagnostic[]): ValidationGate {
  if (diagnostics.some((item) => item.category === "incomplete")) {
    return "INCOMPLETE";
  }
  return diagnostics.length === 0 ? "PASS" : "WARN";
}

export async function validateAgentInstructions(
  repositoryPath: string,
  options: ValidateAgentInstructionsOptions = {},
): Promise<AgentInstructionValidationReport> {
  const maxFileBytes = boundedPositiveInteger(
    options.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    HARD_MAX_FILE_BYTES,
    "Instruction file byte limit",
  );
  const maxTotalBytes = boundedPositiveInteger(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    HARD_MAX_TOTAL_BYTES,
    "Total instruction byte limit",
  );
  const maxDiagnostics = boundedPositiveInteger(
    options.maxDiagnostics,
    DEFAULT_MAX_DIAGNOSTICS,
    HARD_MAX_DIAGNOSTICS,
    "Diagnostic limit",
  );
  const discovery = await discoverInstructionScopes(repositoryPath, options);
  const diagnostics = new BoundedDiagnosticCollector(maxDiagnostics);
  diagnostics.add(...discovery.diagnostics);
  const budget: ReadBudget = { totalBytes: 0 };
  const instructions = new Map<string, ReadInstruction>();
  let filesChecked = 0;

  for (const scope of discovery.scopes) {
    if (scope.canonical === undefined) {
      for (const peer of scope.peers) {
        filesChecked += 1;
        diagnostics.add(
          diagnostic(
            "ORPHAN_PEER_SCOPE",
            "policy",
            peer.relativePath,
            "Peer Agent document has no same-directory AGENTS.md",
          ),
        );
        if (peer.symbolicLink) {
          const target = await resolveInstructionRealPath(
            discovery.repository,
            peer,
          );
          if (typeof target !== "string" && target.diagnostic !== undefined) {
            diagnostics.add(target.diagnostic);
          }
        }
      }
      continue;
    }

    filesChecked += 1;
    const canonicalRead = await readInstruction(
      discovery.repository,
      scope.canonical,
      maxFileBytes,
      maxTotalBytes,
      budget,
    );
    if (canonicalRead.diagnostic !== undefined) {
      diagnostics.add(canonicalRead.diagnostic);
      continue;
    }
    const canonical = canonicalRead.instruction;
    if (canonical === undefined) {
      continue;
    }
    instructions.set(scope.canonical.absolutePath, canonical);

    for (const peerFile of scope.peers) {
      filesChecked += 1;
      if (peerFile.symbolicLink) {
        const peerTarget = await resolveInstructionRealPath(
          discovery.repository,
          peerFile,
        );
        if (typeof peerTarget !== "string") {
          if (peerTarget.diagnostic !== undefined) {
            diagnostics.add(peerTarget.diagnostic);
          }
        } else if (peerTarget !== canonical.realPath) {
          diagnostics.add(
            diagnostic(
              "SYMLINK_TARGET_MISMATCH",
              "policy",
              peerFile.relativePath,
              "Peer symlink does not resolve to the same-scope AGENTS.md",
              canonical.file.relativePath,
            ),
          );
        }
        continue;
      }

      const peerRead = await readInstruction(
        discovery.repository,
        peerFile,
        maxFileBytes,
        maxTotalBytes,
        budget,
      );
      if (peerRead.diagnostic !== undefined) {
        diagnostics.add(peerRead.diagnostic);
        continue;
      }
      const peer = peerRead.instruction;
      if (peer === undefined) {
        continue;
      }
      instructions.set(peerFile.absolutePath, peer);
      diagnostics.add(...policyDiagnostics(scope, canonical, peer));
    }
  }

  const cyclic = cycleComponents(discovery.repository, instructions);
  for (const [absolutePath, component] of cyclic) {
    const instruction = instructions.get(absolutePath);
    if (instruction === undefined) {
      continue;
    }
    diagnostics.add(
      diagnostic(
        "REFERENCE_CYCLE",
        "policy",
        instruction.file.relativePath,
        "Agent instruction references participate in a cycle",
        undefined,
        cyclicReferenceLocation(
          discovery.repository,
          absolutePath,
          instruction,
          component,
        ),
      ),
    );
  }

  const sortedDiagnostics = diagnostics.toArray();
  return {
    ruleId: AGENT_DOCUMENT_RULE_ID,
    gate: gateFor(sortedDiagnostics),
    repository: discovery.repository,
    scopesChecked: discovery.scopes.length,
    filesChecked,
    diagnostics: sortedDiagnostics,
  };
}
