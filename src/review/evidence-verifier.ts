import { TextDecoder } from "node:util";

import {
  createFinding,
  normalizeFindingTitle,
  transitionFinding,
  type Finding,
  type FindingDisposition,
} from "../core/findings.js";
import type { ReviewSnapshot } from "../core/snapshots.js";
import type { ReviewContextBundle } from "./context.js";
import type { StageCandidate } from "./stage-output.js";

export interface ProviderCandidate extends Omit<
  StageCandidate,
  "path" | "startLine" | "endLine" | "sourceQuote" | "contractFact"
> {
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly sourceQuote?: string;
  readonly contractFact?: string;
}

export interface VerificationFact {
  readonly kind: "deterministic" | "runtime_contract";
  readonly statement: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface BlockingEvidenceVerifier {
  verify(input: {
    readonly stageId: string;
    readonly candidate: ProviderCandidate;
    readonly snapshot: ReviewSnapshot;
    readonly context?: ReviewContextBundle;
  }): VerificationFact | undefined;
}

export interface CandidateVerificationOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly blockingEvidenceVerifier?: BlockingEvidenceVerifier;
}

export interface ImmutableSourceQuote {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly sourceQuote: string;
}

export function createImmutableSourceQuoteVerifier(
  snapshot: ReviewSnapshot,
  context?: ReviewContextBundle,
): (evidence: ImmutableSourceQuote) => boolean {
  const diffLines = diffLinesByPath(snapshot.diff, snapshot);
  return (evidence) =>
    verifyEvidence(
      {
        title: "Score assessment evidence",
        severity: "NIT",
        evidence: "Score assessment evidence from an immutable source range",
        ...evidence,
      },
      snapshot,
      context,
      diffLines,
    ).supported;
}

interface EvidenceResult {
  readonly supported: boolean;
  readonly reason: string;
  readonly disposition: FindingDisposition;
}

const MAX_EVIDENCE_RANGE_LINES = 200;
const MIN_QUOTE_LENGTH = 8;

function unsupportedEvidence(reason: string): EvidenceResult {
  return { supported: false, reason, disposition: "unknown" };
}

function normalizedQuote(candidate: ProviderCandidate): string {
  return normalizeEvidenceText(
    candidate.sourceQuote ?? candidate.contractFact ?? "",
  );
}

function normalizeEvidenceText(value: string): string {
  return value
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function capturedRange(
  content: string,
  startLine: number,
  endLine: number,
): string | undefined {
  const lines = content.split(/\r?\n/u);
  if (startLine > endLine || endLine > lines.length) return undefined;
  return lines.slice(startLine - 1, endLine).join("\n");
}

interface DiffLine {
  readonly content: string;
  readonly changed: boolean;
}

interface DiffLines {
  readonly old: ReadonlyMap<string, DiffLine>;
  readonly current: ReadonlyMap<string, DiffLine>;
}

function setDiffLine(
  target: Map<string, DiffLine>,
  path: string | undefined,
  line: number | undefined,
  content: string,
  changed: boolean,
): void {
  if (path !== undefined && line !== undefined) {
    target.set(`${path}\0${String(line)}`, { content, changed });
  }
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

function decodeQuotedGitPath(value: string): string | undefined {
  const bytes: number[] = [];
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      try {
        return fatalUtf8.decode(Uint8Array.from(bytes));
      } catch {
        return undefined;
      }
    }
    if (character !== "\\") {
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined) return undefined;
      const literal = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(literal, "utf8"));
      if (literal.length === 2) index += 1;
      continue;
    }
    const escaped = value[(index += 1)];
    if (escaped === undefined) return undefined;
    const octal = /^[0-7]$/u.test(escaped);
    if (octal) {
      let digits = escaped;
      for (let count = 1; count < 3; count += 1) {
        const next = value[index + 1];
        if (next === undefined || !/^[0-7]$/u.test(next)) break;
        digits += next;
        index += 1;
      }
      const byte = Number.parseInt(digits, 8);
      if (byte > 0xff) return undefined;
      bytes.push(byte);
      continue;
    }
    const escapes: Readonly<Record<string, number>> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      '"': 34,
      "\\": 92,
    };
    const byte = escapes[escaped];
    if (byte === undefined) return undefined;
    bytes.push(byte);
  }
  return undefined;
}

function diffPath(value: string): string | undefined {
  if (value === "/dev/null") return undefined;
  const decoded = value.startsWith('"') ? decodeQuotedGitPath(value) : value;
  return decoded?.replace(/^[ab]\//u, "");
}

function currentSnapshotPath(
  path: string | undefined,
  snapshot: ReviewSnapshot,
): string | undefined {
  if (path === undefined) return undefined;
  return (
    snapshot.files.find((file) => file.path === path)?.path ??
    snapshot.files.find((file) => file.previousPath === path)?.path ??
    path
  );
}

function diffLinesByPath(
  diff: string | undefined,
  snapshot: ReviewSnapshot,
): DiffLines {
  const old = new Map<string, DiffLine>();
  const current = new Map<string, DiffLine>();
  if (diff === undefined) return { old, current };
  let oldPath: string | undefined;
  let currentPath: string | undefined;
  let oldLine: number | undefined;
  let currentLine: number | undefined;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("--- ")) {
      oldPath = diffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      currentPath = diffPath(line.slice(4));
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      currentLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith(" ")) {
      setDiffLine(
        old,
        currentSnapshotPath(oldPath, snapshot),
        oldLine,
        line.slice(1),
        false,
      );
      setDiffLine(
        current,
        currentSnapshotPath(currentPath, snapshot),
        currentLine,
        line.slice(1),
        false,
      );
      if (oldLine !== undefined) oldLine += 1;
      if (currentLine !== undefined) currentLine += 1;
    } else if (line.startsWith("-")) {
      setDiffLine(
        old,
        currentSnapshotPath(oldPath, snapshot),
        oldLine,
        line.slice(1),
        true,
      );
      if (oldLine !== undefined) oldLine += 1;
    } else if (line.startsWith("+")) {
      setDiffLine(
        current,
        currentSnapshotPath(currentPath, snapshot),
        currentLine,
        line.slice(1),
        true,
      );
      if (currentLine !== undefined) currentLine += 1;
    }
  }
  return { old, current };
}

function diffRange(
  lines: ReadonlyMap<string, DiffLine>,
  candidate: ProviderCandidate,
): { readonly text: string; readonly changed: boolean } | undefined {
  if (
    candidate.path === undefined ||
    candidate.startLine === undefined ||
    candidate.endLine === undefined
  ) {
    return undefined;
  }
  const selected: string[] = [];
  let changed = false;
  for (let line = candidate.startLine; line <= candidate.endLine; line += 1) {
    const value = lines.get(`${candidate.path}\0${String(line)}`);
    if (value === undefined) return undefined;
    selected.push(value.content);
    changed ||= value.changed;
  }
  return { text: selected.join("\n"), changed };
}

interface CapturedEvidenceRange {
  readonly source: string;
  readonly text: string;
  readonly disposition: FindingDisposition;
}

function contextDisposition(
  snapshot: ReviewSnapshot,
  path: string,
): FindingDisposition {
  if (snapshot.scope === "repository") return "preexisting";
  const file = snapshot.files.find((item) => item.path === path);
  if (file?.status === "renamed") return "preexisting";
  if (file?.status === "added") return "new";
  return "unknown";
}

function capturedEvidenceRanges(
  candidate: ProviderCandidate,
  context: ReviewContextBundle | undefined,
  diffLines: DiffLines,
  snapshot: ReviewSnapshot,
): readonly CapturedEvidenceRange[] {
  if (
    candidate.path === undefined ||
    candidate.startLine === undefined ||
    candidate.endLine === undefined
  ) {
    return [];
  }
  const file = context?.files.find((item) => item.path === candidate.path);
  const currentRange = diffRange(diffLines.current, candidate);
  const oldRange = diffRange(diffLines.old, candidate);
  const values = [
    {
      source: "context",
      text:
        file === undefined
          ? undefined
          : capturedRange(file.content, candidate.startLine, candidate.endLine),
      disposition: contextDisposition(snapshot, candidate.path),
    },
    {
      source: "diff",
      text: currentRange?.text,
      disposition:
        snapshot.scope === "repository"
          ? ("preexisting" as const)
          : currentRange?.changed === true
            ? ("new" as const)
            : ("preexisting" as const),
    },
    {
      source: "diff-old",
      text: oldRange?.text,
      disposition:
        snapshot.scope === "repository"
          ? ("preexisting" as const)
          : oldRange?.changed === true
            ? ("new" as const)
            : ("preexisting" as const),
    },
  ];
  return values.flatMap((value) =>
    value.text === undefined
      ? []
      : [
          {
            source: value.source,
            text: value.text,
            disposition: value.disposition,
          },
        ],
  );
}

function validateEvidenceLocation(
  candidate: ProviderCandidate,
  snapshot: ReviewSnapshot,
): EvidenceResult | undefined {
  if (
    candidate.path === undefined ||
    candidate.startLine === undefined ||
    candidate.endLine === undefined
  ) {
    return unsupportedEvidence("Evidence location is incomplete");
  }
  if (
    !Number.isSafeInteger(candidate.startLine) ||
    !Number.isSafeInteger(candidate.endLine) ||
    candidate.startLine < 1 ||
    candidate.endLine < candidate.startLine
  ) {
    return unsupportedEvidence("Evidence line range is invalid");
  }
  if (candidate.endLine - candidate.startLine + 1 > MAX_EVIDENCE_RANGE_LINES) {
    return unsupportedEvidence(
      "Evidence line range exceeds the verification limit",
    );
  }
  if (!snapshot.files.some((file) => file.path === candidate.path)) {
    return unsupportedEvidence("Path is not present in the snapshot");
  }
  return undefined;
}

function verifyEvidence(
  candidate: ProviderCandidate,
  snapshot: ReviewSnapshot,
  context: ReviewContextBundle | undefined,
  diffLines: DiffLines,
): EvidenceResult {
  const locationFailure = validateEvidenceLocation(candidate, snapshot);
  if (locationFailure !== undefined) return locationFailure;
  const quote = normalizedQuote(candidate);
  if (quote.length < MIN_QUOTE_LENGTH) {
    return unsupportedEvidence(
      "Quoted evidence is not substantive enough to verify",
    );
  }
  const ranges = capturedEvidenceRanges(
    candidate,
    context,
    diffLines,
    snapshot,
  );
  if (ranges.length === 0) {
    return unsupportedEvidence(
      "Line range is outside all captured source ranges",
    );
  }
  const matches = ranges.filter(
    (range) => normalizeEvidenceText(range.text) === quote,
  );
  const matched =
    matches.find((range) => range.disposition === "new") ??
    matches.find((range) => range.disposition === "preexisting") ??
    matches[0];
  if (matched !== undefined) {
    return {
      supported: true,
      reason: `Matched quoted evidence against immutable ${matched.source}`,
      disposition: matched.disposition,
    };
  }
  return unsupportedEvidence(
    "Quoted evidence does not match the complete captured range",
  );
}

function candidateKey(candidate: ProviderCandidate): string {
  return [
    candidate.path ?? "",
    candidate.startLine ?? "",
    candidate.endLine ?? "",
    normalizeFindingTitle(candidate.title),
  ].join("\0");
}

function conflictKeys(
  candidates: readonly ProviderCandidate[],
): ReadonlySet<string> {
  const severities = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const values = severities.get(key) ?? new Set<string>();
    values.add(candidate.severity);
    severities.set(key, values);
  }
  return new Set(
    [...severities.entries()]
      .filter(([, values]) => values.size > 1)
      .map(([key]) => key),
  );
}

function findingFromCandidate(
  stageId: string,
  index: number,
  candidate: ProviderCandidate,
  verification: string,
  blockingVerificationUnresolved: boolean,
  disposition: FindingDisposition,
  options: CandidateVerificationOptions | undefined,
): Finding {
  return createFinding({
    id: `${stageId}-${String(index + 1)}`,
    title: candidate.title,
    severity: candidate.severity,
    disposition,
    confidence: "low",
    stages: [stageId],
    ...(candidate.path === undefined
      ? {}
      : {
          location: {
            path: candidate.path,
            ...(candidate.startLine === undefined
              ? {}
              : { startLine: candidate.startLine }),
            ...(candidate.endLine === undefined
              ? {}
              : { endLine: candidate.endLine }),
          },
        }),
    evidence: candidate.evidence,
    impact: candidate.impact ?? "See evidence",
    remediation: candidate.remediation ?? "See evidence",
    trigger: `stage:${stageId}`,
    actualBehavior: candidate.evidence,
    expectedBehavior:
      candidate.remediation ?? "Behavior should match project contracts",
    verification,
    ...(blockingVerificationUnresolved
      ? { blockingVerificationUnresolved: true }
      : {}),
    ...(options?.provider === undefined ? {} : { provider: options.provider }),
    ...(options?.model === undefined ? {} : { model: options.model }),
  });
}

function isBlocking(candidate: ProviderCandidate): boolean {
  return candidate.severity === "P0" || candidate.severity === "P1";
}

function validVerificationFact(
  fact: unknown,
  candidate: ProviderCandidate,
): fact is VerificationFact {
  if (fact === null || typeof fact !== "object") return false;
  const value = fact as Record<string, unknown>;
  return (
    (value.kind === "deterministic" || value.kind === "runtime_contract") &&
    typeof value.statement === "string" &&
    value.statement.trim().length >= 12 &&
    value.path === candidate.path &&
    value.startLine === candidate.startLine &&
    value.endLine === candidate.endLine
  );
}

function blockingFact(
  stageId: string,
  candidate: ProviderCandidate,
  snapshot: ReviewSnapshot,
  context: ReviewContextBundle | undefined,
  verifier: BlockingEvidenceVerifier | undefined,
): VerificationFact | undefined {
  if (verifier === undefined) return undefined;
  try {
    const fact = verifier.verify({
      stageId,
      candidate,
      snapshot,
      ...(context === undefined ? {} : { context }),
    });
    return validVerificationFact(fact, candidate) ? fact : undefined;
  } catch {
    return undefined;
  }
}

export function verifyCandidates(
  stageId: string,
  candidates: readonly ProviderCandidate[],
  snapshot: ReviewSnapshot,
  context?: ReviewContextBundle,
  options?: CandidateVerificationOptions,
): readonly Finding[] {
  const diffLines = diffLinesByPath(snapshot.diff, snapshot);
  const conflicts = conflictKeys(candidates);
  return Object.freeze(
    candidates.map((candidate, index) => {
      const evidence = verifyEvidence(candidate, snapshot, context, diffLines);
      const conflict = conflicts.has(candidateKey(candidate));
      const fact =
        evidence.supported && isBlocking(candidate)
          ? blockingFact(
              stageId,
              candidate,
              snapshot,
              context,
              options?.blockingEvidenceVerifier,
            )
          : undefined;
      const behaviorUnverified =
        evidence.supported && isBlocking(candidate) && fact === undefined;
      const verification = conflict
        ? "Candidate severity conflict requires adjudication"
        : fact === undefined
          ? behaviorUnverified
            ? "Source corroborated against immutable review content; blocking behavior unverified by an independent verifier"
            : evidence.reason
          : `${evidence.reason}; ${fact.kind} verification: ${fact.statement}`;
      let finding = findingFromCandidate(
        stageId,
        index,
        candidate,
        verification,
        behaviorUnverified,
        evidence.disposition,
        options,
      );
      if (conflict || !evidence.supported) {
        return transitionFinding(finding, "uncertain");
      }
      finding = transitionFinding(finding, "corroborated");
      if (behaviorUnverified) return finding;
      finding = transitionFinding(finding, "confirmed");
      return Object.freeze({ ...finding, confidence: "high" as const });
    }),
  );
}
