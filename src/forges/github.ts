import { createReviewSnapshot, type SnapshotFile } from "../core/snapshots.js";
import { trustedForgeCloneUrl } from "./forge.js";
import type {
  ForgeCredentials,
  ForgeReadResult,
  ForgeReader,
  ForgeTransport,
} from "./forge.js";
import type { ParsedForgeUrl } from "./url.js";

const MAX_FORGE_FILES = 200;

interface GitHubPullRequest {
  readonly title?: string;
  readonly body?: string | null;
  readonly base?: {
    readonly sha?: string;
    readonly repo?: { readonly clone_url?: string };
  };
  readonly head?: {
    readonly sha?: string;
    readonly repo?: { readonly clone_url?: string };
  };
  readonly user?: { readonly login?: string };
  readonly changed_files?: number;
}

interface GitHubFileRow {
  readonly filename?: string;
  readonly status?: string;
  readonly previous_filename?: string;
  readonly patch?: string;
  readonly additions?: number;
  readonly deletions?: number;
}

function requiredRevision(value: string | undefined, forge: string): string {
  const revision = value ?? "";
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error(`${forge} pull request revisions are invalid`);
  }
  return revision;
}

function cloneUrls(
  url: ParsedForgeUrl,
  pullRequest: GitHubPullRequest,
): { readonly cloneUrl: string; readonly headCloneUrl: string } {
  const defaultUrl = `https://github.com/${url.owner}/${url.repository}.git`;
  const trustedBase = trustedForgeCloneUrl(
    pullRequest.base?.repo?.clone_url,
    "github",
  );
  const cloneUrl = trustedBase === undefined ? defaultUrl : trustedBase;
  const trustedHead = trustedForgeCloneUrl(
    pullRequest.head?.repo?.clone_url,
    "github",
  );
  const headCloneUrl = trustedHead === undefined ? cloneUrl : trustedHead;
  return { cloneUrl, headCloneUrl };
}

function metadataFor(
  body: GitHubPullRequest,
  baseSha: string,
  headSha: string,
  cloneUrl: string,
  headCloneUrl: string,
): ForgeReadResult["metadata"] {
  const metadata: {
    title: string;
    description: string;
    baseSha: string;
    headSha: string;
    cloneUrl: string;
    headCloneUrl: string;
    author?: string;
  } = {
    title: body.title ?? "",
    description: body.body ?? "",
    baseSha,
    headSha,
    cloneUrl,
    headCloneUrl,
  };
  if (body.user?.login !== undefined) metadata.author = body.user.login;
  return metadata;
}

function requestHeaders(credentials: ForgeCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "code-quality-cli",
  };
  if (credentials.token !== undefined) {
    headers.Authorization = `Bearer ${credentials.token}`;
  }
  return headers;
}

function mapStatus(status: string | undefined): SnapshotFile["status"] {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    case "changed":
    case "modified":
      return "modified";
    default:
      return "modified";
  }
}

function snapshotFile(row: GitHubFileRow): SnapshotFile | undefined {
  if (typeof row.filename !== "string" || row.filename.length === 0) {
    return undefined;
  }
  const file: {
    path: string;
    status: SnapshotFile["status"];
    binary: boolean;
    previousPath?: string;
    additions?: number;
    deletions?: number;
  } = {
    path: row.filename,
    status: mapStatus(row.status),
    binary: row.patch === undefined,
  };
  if (typeof row.previous_filename === "string") {
    file.previousPath = row.previous_filename;
  }
  if (typeof row.additions === "number") file.additions = row.additions;
  if (typeof row.deletions === "number") file.deletions = row.deletions;
  return file;
}

async function readChangedFiles(options: {
  readonly api: string;
  readonly headers: Record<string, string>;
  readonly pullRequest: GitHubPullRequest;
  readonly url: ParsedForgeUrl;
  readonly transport: ForgeTransport;
}): Promise<{
  readonly files: readonly SnapshotFile[];
  readonly incomplete: boolean;
  readonly diff: string;
}> {
  const response = await options.transport.fetch(
    `${options.api}/files?per_page=100`,
    { headers: options.headers },
  );
  if (!response.ok) {
    return {
      files: [],
      incomplete: true,
      diff: `github-pr:${options.url.canonicalUrl}`,
    };
  }
  const rows = (await response.json()) as readonly GitHubFileRow[];
  const files = rows
    .slice(0, MAX_FORGE_FILES)
    .map(snapshotFile)
    .filter((file): file is SnapshotFile => file !== undefined);
  const patches = rows
    .slice(0, 50)
    .map((row) => row.patch)
    .filter((patch): patch is string => typeof patch === "string");
  const changedFiles = options.pullRequest.changed_files;
  const incomplete =
    rows.length >= MAX_FORGE_FILES ||
    (changedFiles !== undefined && changedFiles > rows.length);
  return {
    files,
    incomplete,
    diff:
      patches.length === 0
        ? `github-pr:${options.url.canonicalUrl}`
        : patches.join("\n").slice(0, 512 * 1024),
  };
}

export class GitHubForgeReader implements ForgeReader {
  async read(
    url: ParsedForgeUrl,
    credentials: ForgeCredentials,
    transport: ForgeTransport,
  ): Promise<ForgeReadResult> {
    const headers = requestHeaders(credentials);
    const api = `https://api.github.com/repos/${url.owner}/${url.repository}/pulls/${String(url.number)}`;
    const response = await transport.fetch(api, { headers });
    if (!response.ok) {
      throw new Error(
        `GitHub API request failed with status ${String(response.status)}`,
      );
    }
    const body = (await response.json()) as GitHubPullRequest;
    const baseSha = requiredRevision(body.base?.sha, "GitHub");
    const headSha = requiredRevision(body.head?.sha, "GitHub");
    const { cloneUrl, headCloneUrl } = cloneUrls(url, body);

    const changed = await readChangedFiles({
      api,
      headers,
      pullRequest: body,
      url,
      transport,
    });

    const snapshot = createReviewSnapshot({
      inputKind: "github_pr",
      scope: "change",
      repository: `${url.owner}/${url.repository}`,
      comparisonBase: baseSha,
      head: headSha,
      files: changed.files,
      exclusions: [],
      incomplete: changed.incomplete,
      diff: changed.diff,
    });
    return {
      url,
      metadata: metadataFor(body, baseSha, headSha, cloneUrl, headCloneUrl),
      snapshot,
    };
  }
}
