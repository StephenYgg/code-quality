import type { Nodes, Parent, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

const REFERENCE_TOKEN =
  /[A-Za-z][A-Za-z0-9+.-]*:[^\s`<>()]*?\.md(?![A-Za-z0-9_\\/-]|\.[A-Za-z0-9])(?:[?#][^\s`<>()]+)?|(?:[\\/]|\.{1,2}[\\/])?(?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9._-]+\.md(?![A-Za-z0-9_\\/-]|\.[A-Za-z0-9])(?:[?#][^\s`<>()]+)?/giu;
const MINIMUM_POLICY_BLOCK_LENGTH = 120;
const MAXIMUM_MARKDOWN_LINES = 10_000;
const MAXIMUM_MARKDOWN_MARKERS = 50_000;
const MAXIMUM_MARKDOWN_NODES = 20_000;
const MARKDOWN_MARKERS = new Set([
  "[",
  "]",
  "(",
  ")",
  "`",
  "*",
  "_",
  "#",
  ">",
  "+",
  "-",
]);
const TEXT_SEPARATOR = Symbol("markdown text separator");

export class MarkdownLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownLimitError";
  }
}

export interface MarkdownHeading {
  readonly depth: number;
  readonly title: string;
  readonly line: number;
  readonly column: number;
}

export interface MarkdownParagraph {
  readonly text: string;
  readonly section?: string;
  readonly references: readonly string[];
  readonly line: number;
  readonly column: number;
}

export interface NormalizedMarkdownBlock {
  readonly value: string;
  readonly line: number;
  readonly column: number;
}

export interface MarkdownLinkTarget {
  readonly target: string;
  readonly line: number;
  readonly column: number;
}

export interface ParsedInstructionMarkdown {
  readonly references: readonly string[];
  readonly linkTargets: readonly string[];
  readonly linkTargetLocations: readonly MarkdownLinkTarget[];
  readonly headings: readonly MarkdownHeading[];
  readonly paragraphs: readonly MarkdownParagraph[];
  readonly normalizedBlocks: readonly NormalizedMarkdownBlock[];
  readonly canonicalDirective: boolean;
  readonly explicitCanonicalConflict: boolean;
  readonly canonicalDirectiveLocation: MarkdownParagraph | undefined;
  readonly explicitCanonicalConflictLocation: MarkdownParagraph | undefined;
}

function hasChildren(node: Nodes): node is Nodes & Parent {
  return "children" in node;
}

function visibleText(node: Nodes): string {
  const fragments: string[] = [];
  const pending: Array<Nodes | typeof TEXT_SEPARATOR> = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === TEXT_SEPARATOR) {
      fragments.push(" ");
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if ("value" in current && typeof current.value === "string") {
      fragments.push(current.value);
      continue;
    }
    if (!hasChildren(current)) {
      continue;
    }
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      const child = current.children[index];
      if (child !== undefined) {
        pending.push(child);
        if (index > 0) {
          pending.push(TEXT_SEPARATOR);
        }
      }
    }
  }
  return fragments.join("");
}

function markdownLocation(node: Nodes): {
  readonly line: number;
  readonly column: number;
} {
  return {
    line: node.position?.start.line ?? 1,
    column: node.position?.start.column ?? 1,
  };
}

function normalizeBlock(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function referenceTokens(value: string): string[] {
  return [...value.matchAll(REFERENCE_TOKEN)].map((match) => match[0]);
}

function assertMarkdownPreflightLimits(source: string): void {
  let lines = 1;
  let markers = 0;
  for (const character of source) {
    if (character === "\n") {
      lines += 1;
      if (lines > MAXIMUM_MARKDOWN_LINES) {
        throw new MarkdownLimitError(
          `Markdown line limit of ${String(MAXIMUM_MARKDOWN_LINES)} was exceeded`,
        );
      }
    }
    if (MARKDOWN_MARKERS.has(character)) {
      markers += 1;
      if (markers > MAXIMUM_MARKDOWN_MARKERS) {
        throw new MarkdownLimitError(
          `Markdown syntax marker limit of ${String(MAXIMUM_MARKDOWN_MARKERS)} was exceeded`,
        );
      }
    }
  }
}

function collectDefinitions(root: Root): Map<string, string> {
  const definitions = new Map<string, string>();
  const pending: Nodes[] = [...root.children];
  let index = 0;
  while (index < pending.length) {
    const node = pending[index];
    index += 1;
    if (node === undefined) {
      continue;
    }
    if (node.type === "definition") {
      definitions.set(node.identifier.toLocaleLowerCase("en-US"), node.url);
    }
    if (hasChildren(node)) {
      pending.push(...node.children);
    }
    if (pending.length > MAXIMUM_MARKDOWN_NODES) {
      throw new MarkdownLimitError(
        `Markdown node limit of ${String(MAXIMUM_MARKDOWN_NODES)} was exceeded`,
      );
    }
  }
  return definitions;
}

function referencesIn(
  node: Nodes,
  definitions: ReadonlyMap<string, string>,
): string[] {
  const references: string[] = [];
  const pending: Nodes[] = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    if (current.type === "link") {
      references.push(current.url);
      continue;
    }
    if (current.type === "linkReference") {
      const target = definitions.get(
        current.identifier.toLocaleLowerCase("en-US"),
      );
      if (target !== undefined) {
        references.push(target);
      }
      continue;
    }
    if (current.type === "inlineCode" || current.type === "text") {
      references.push(...referenceTokens(current.value));
    }
    if (hasChildren(current)) {
      for (let index = current.children.length - 1; index >= 0; index -= 1) {
        const child = current.children[index];
        if (child !== undefined) {
          pending.push(child);
        }
      }
    }
  }
  return references;
}

function directiveText(
  node: Nodes,
  definitions: ReadonlyMap<string, string>,
): string {
  const fragments: string[] = [];
  const pending: Array<Nodes | typeof TEXT_SEPARATOR> = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === TEXT_SEPARATOR) {
      fragments.push(" ");
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if (current.type === "link") {
      fragments.push(`${visibleText(current)} ${directiveTarget(current.url)}`);
      continue;
    }
    if (current.type === "linkReference") {
      const target = definitions.get(
        current.identifier.toLocaleLowerCase("en-US"),
      );
      fragments.push(
        target === undefined
          ? visibleText(current)
          : `${visibleText(current)} ${directiveTarget(target)}`,
      );
      continue;
    }
    if ("value" in current && typeof current.value === "string") {
      fragments.push(current.value);
      continue;
    }
    if (!hasChildren(current)) {
      continue;
    }
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      const child = current.children[index];
      if (child !== undefined) {
        pending.push(child);
        if (index > 0) {
          pending.push(TEXT_SEPARATOR);
        }
      }
    }
  }
  return fragments.join("");
}

function directiveTarget(target: string): string {
  const normalized = target.replaceAll("\\", "/");
  return normalized === "AGENTS.md" || normalized === "./AGENTS.md"
    ? "AGENTS.md"
    : target;
}

function canonicalClauses(value: string): string[] {
  return value
    .normalize("NFKC")
    .replace(/agents\.md/giu, "AGENTS_MD")
    .split(/[.!?;。！？；\n]+/u);
}

function hasExplicitCanonicalConflict(value: string): boolean {
  return canonicalClauses(value).some((clause) => {
    if (!/AGENTS_MD/u.test(clause)) {
      return false;
    }
    const protectsCanonical =
      /\b(?:must not|never|do not)\b.{0,60}\b(?:ignore|override)\b.{0,60}AGENTS_MD/iu.test(
        clause,
      ) ||
      /\bignore\b.{0,20}\b(?:any\s+)?(?:instruction|instructions|request|requests|rule|rules)\b.{0,80}\b(?:ignore|override|weaken)\b.{0,40}AGENTS_MD/iu.test(
        clause,
      ) ||
      /\b(?:reject|block|refuse)\b.{0,30}\b(?:any\s+)?(?:attempt|attempts|instruction|instructions|request|requests|rule|rules)\b.{0,80}\b(?:ignore|override|weaken)\b.{0,40}AGENTS_MD/iu.test(
        clause,
      ) ||
      /(?:不得|不能).{0,40}(?:忽略|覆盖|弱化).{0,40}AGENTS_MD/iu.test(clause) ||
      /忽略.{0,20}(?:任何)?(?:要求|指示|指令|规则|请求).{0,60}(?:忽略|覆盖|弱化).{0,40}AGENTS_MD/iu.test(
        clause,
      );
    if (protectsCanonical) {
      return false;
    }
    return (
      /\bdo not\s+(?:read|follow|obey|import|include)\b.{0,60}AGENTS_MD/iu.test(
        clause,
      ) ||
      /\bdo not comply with\b.{0,60}AGENTS_MD/iu.test(clause) ||
      /\b(?:ignore|override)\b.{0,60}AGENTS_MD/iu.test(clause) ||
      /AGENTS_MD.{0,60}\b(?:must|can|may|should)\s+be\s+(?:ignored|overridden)\b/iu.test(
        clause,
      ) ||
      /(?:忽略|无需遵守|覆盖).{0,40}AGENTS_MD/iu.test(clause) ||
      /AGENTS_MD.{0,40}(?:无需遵守|可以忽略|必须忽略|应当忽略)/iu.test(clause)
    );
  });
}

function hasCanonicalDirective(
  value: string,
  references: readonly string[],
): boolean {
  const exactCanonicalReferences = references.filter((reference) => {
    const normalized = reference.replaceAll("\\", "/");
    return normalized === "AGENTS.md" || normalized === "./AGENTS.md";
  });
  if (exactCanonicalReferences.length === 0) {
    return false;
  }
  const clauses = canonicalClauses(value);
  const rejectsCompliance = clauses.some(
    (clause) =>
      /\b(?:must not|never|do not)\b.{0,50}\b(?:read|follow|obey|import|include)\b/iu.test(
        clause,
      ) ||
      /\bdo not comply with\b/iu.test(clause) ||
      /(?:不要|不得|无需).{0,30}(?:读取|阅读|遵守|导入|引用)/u.test(clause),
  );
  if (rejectsCompliance) {
    return false;
  }
  const boundDirective = clauses.some((clause) => {
    if (/AGENTS_MD/u.test(clause)) {
      return (
        /\bread\s+and\s+(?:follow|obey)\b.{0,60}AGENTS_MD/iu.test(clause) ||
        /\bread\b.{0,60}AGENTS_MD.{0,80}\b(?:and\s+)?(?:follow|obey)\s+(?:it|them|these|those|the\s+(?:rules|instructions))\b/iu.test(
          clause,
        ) ||
        /\bread\b.{0,60}AGENTS_MD.{0,80}\b(?:and\s+)?comply with\s+(?:it|them|these|those|the\s+(?:rules|instructions))\b/iu.test(
          clause,
        ) ||
        /AGENTS_MD.{0,60}\b(?:must|should)\s+be\s+read\b.{0,60}\band\s+(?:followed|obeyed)\b/iu.test(
          clause,
        ) ||
        /(?:读取|阅读).{0,40}(?:并|且).{0,20}(?:遵守|服从).{0,40}AGENTS_MD/u.test(
          clause,
        ) ||
        /(?:读取|阅读).{0,40}AGENTS_MD.{0,40}(?:并|且).{0,20}(?:遵守|服从)(?:它|这些|上述|该)?/u.test(
          clause,
        )
      );
    }
    return false;
  });
  if (boundDirective) {
    return true;
  }
  return clauses.some((clause, index) => {
    const readsCanonical =
      /\bread\b.{0,60}AGENTS_MD/iu.test(clause) ||
      /(?:读取|阅读).{0,40}AGENTS_MD/u.test(clause);
    if (!readsCanonical) {
      return false;
    }
    const nextClause = clauses[index + 1] ?? "";
    return (
      /^\s*(?:you\s+)?(?:(?:must|should)\s+)?(?:follow|obey)\s+(?:it|them|these|those|the\s+(?:rules|instructions))\b/iu.test(
        nextClause,
      ) ||
      /^\s*(?:you\s+)?(?:(?:must|should)\s+)?comply with\s+(?:it|them|these|those|the\s+(?:rules|instructions))\b/iu.test(
        nextClause,
      ) ||
      /^\s*(?:遵守|服从)(?:它|这些|上述|该)(?:规则|指令|要求)?/u.test(
        nextClause,
      )
    );
  });
}

export function parseInstructionMarkdown(
  source: string,
): ParsedInstructionMarkdown {
  assertMarkdownPreflightLimits(source);
  const root: Root = fromMarkdown(source);
  const definitions = collectDefinitions(root);
  const references = new Set<string>();
  const linkTargets = new Set<string>();
  const linkTargetLocations: MarkdownLinkTarget[] = [];
  const headings: MarkdownHeading[] = [];
  const paragraphs: MarkdownParagraph[] = [];
  const normalizedBlocks = new Map<
    string,
    { readonly line: number; readonly column: number }
  >();
  let canonicalDirectiveLocation: MarkdownParagraph | undefined;
  let explicitCanonicalConflictLocation: MarkdownParagraph | undefined;
  let visitedNodes = 0;

  function visit(startNode: Nodes, section: string | undefined): void {
    const pending: Array<{ node: Nodes; insideLink: boolean }> = [
      { node: startNode, insideLink: false },
    ];
    while (pending.length > 0) {
      const frame = pending.pop();
      if (frame === undefined) {
        continue;
      }
      const { node, insideLink } = frame;
      visitedNodes += 1;
      if (visitedNodes > MAXIMUM_MARKDOWN_NODES) {
        throw new MarkdownLimitError(
          `Markdown node limit of ${String(MAXIMUM_MARKDOWN_NODES)} was exceeded`,
        );
      }
      if (node.type === "link") {
        references.add(node.url);
        linkTargets.add(node.url);
        linkTargetLocations.push({
          target: node.url,
          ...markdownLocation(node),
        });
      } else if (node.type === "linkReference") {
        const target = definitions.get(
          node.identifier.toLocaleLowerCase("en-US"),
        );
        if (target !== undefined) {
          references.add(target);
          linkTargets.add(target);
          linkTargetLocations.push({
            target,
            ...markdownLocation(node),
          });
        }
      } else if (
        !insideLink &&
        (node.type === "inlineCode" || node.type === "text")
      ) {
        for (const reference of referenceTokens(node.value)) {
          references.add(reference);
        }
      }

      if (node.type === "heading") {
        headings.push({
          depth: node.depth,
          title: visibleText(node).replace(/\s+/gu, " ").trim(),
          ...markdownLocation(node),
        });
      }

      if (node.type === "paragraph") {
        const text = visibleText(node).replace(/\s+/gu, " ").trim();
        const directiveAnalysis = directiveText(node, definitions);
        const paragraphReferences = referencesIn(node, definitions);
        const location = markdownLocation(node);
        const parsedParagraph =
          section === undefined
            ? { text, references: paragraphReferences, ...location }
            : { text, section, references: paragraphReferences, ...location };
        paragraphs.push(parsedParagraph);
        const normalized = normalizeBlock(text);
        if (
          normalized.length >= MINIMUM_POLICY_BLOCK_LENGTH &&
          !normalizedBlocks.has(normalized)
        ) {
          normalizedBlocks.set(normalized, location);
        }
        if (
          canonicalDirectiveLocation === undefined &&
          hasCanonicalDirective(directiveAnalysis, paragraphReferences)
        ) {
          canonicalDirectiveLocation = parsedParagraph;
        }
        if (
          explicitCanonicalConflictLocation === undefined &&
          hasExplicitCanonicalConflict(text)
        ) {
          explicitCanonicalConflictLocation = parsedParagraph;
        }
      }

      if (hasChildren(node)) {
        const childInsideLink =
          insideLink || node.type === "link" || node.type === "linkReference";
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const child = node.children[index];
          if (child !== undefined) {
            pending.push({ node: child, insideLink: childInsideLink });
          }
        }
      }
    }
  }

  let currentSection: string | undefined;
  for (const node of root.children) {
    if (node.type === "heading" && node.depth === 2) {
      currentSection = visibleText(node).replace(/\s+/gu, " ").trim();
    }
    visit(node, currentSection);
  }

  return {
    references: [...references],
    linkTargets: [...linkTargets],
    linkTargetLocations,
    headings,
    paragraphs,
    normalizedBlocks: [...normalizedBlocks].map(([value, location]) => ({
      value,
      ...location,
    })),
    canonicalDirective: canonicalDirectiveLocation !== undefined,
    explicitCanonicalConflict: explicitCanonicalConflictLocation !== undefined,
    canonicalDirectiveLocation,
    explicitCanonicalConflictLocation,
  };
}
