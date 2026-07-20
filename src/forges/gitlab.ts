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

interface GitLabMergeRequest {
  readonly title?: string;
  readonly description?: string | null;
  readonly diff_refs?: {
    readonly base_sha?: string;
    readonly head_sha?: string;
  };
  readonly author?: { readonly username?: string };
  readonly source_project_id?: number;
  readonly target_project_id?: number;
}

interface GitLabChange {
  readonly new_path?: string;
  readonly old_path?: string;
  readonly new_file?: boolean;
  readonly deleted_file?: boolean;
  readonly renamed_file?: boolean;
  readonly diff?: string;
}

function requestHeaders(credentials: ForgeCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "code-quality-cli",
  };
  if (credentials.token !== undefined) {
    headers["PRIVATE-TOKEN"] = credentials.token;
  }
  return headers;
}

function snapshotFile(row: GitLabChange): SnapshotFile | undefined {
  const path = row.new_path ?? row.old_path;
  if (typeof path !== "string" || path.length === 0) return undefined;
  let status: SnapshotFile["status"] = "modified";
  if (row.new_file === true) status = "added";
  else if (row.deleted_file === true) status = "deleted";
  else if (row.renamed_file === true) status = "renamed";
  const file: {
    path: string;
    status: SnapshotFile["status"];
    binary: boolean;
    previousPath?: string;
  } = {
    path,
    status,
    binary: row.diff === undefined || row.diff.length === 0,
  };
  if (row.renamed_file === true && typeof row.old_path === "string") {
    file.previousPath = row.old_path;
  }
  return file;
}

async function resolveHeadCloneUrl(options: {
  readonly mergeRequest: GitLabMergeRequest;
  readonly cloneUrl: string;
  readonly headers: Record<string, string>;
  readonly transport: ForgeTransport;
}): Promise<string> {
  const sourceId = options.mergeRequest.source_project_id;
  if (
    sourceId === undefined ||
    sourceId === options.mergeRequest.target_project_id
  ) {
    return options.cloneUrl;
  }
  const response = await options.transport.fetch(
    `https://gitlab.com/api/v4/projects/${String(sourceId)}`,
    { headers: options.headers },
  );
  if (!response.ok) {
    throw new Error(
      `GitLab source project request failed with status ${String(response.status)}`,
    );
  }
  const body = (await response.json()) as {
    readonly http_url_to_repo?: string;
  };
  const trusted = trustedForgeCloneUrl(body.http_url_to_repo, "gitlab");
  if (trusted === undefined) {
    throw new Error("GitLab source project clone URL is invalid");
  }
  return trusted;
}

async function readChanges(options: {
  readonly api: string;
  readonly headers: Record<string, string>;
  readonly url: ParsedForgeUrl;
  readonly transport: ForgeTransport;
}): Promise<{
  readonly files: readonly SnapshotFile[];
  readonly incomplete: boolean;
  readonly diff: string;
}> {
  const response = await options.transport.fetch(`${options.api}/changes`, {
    headers: options.headers,
  });
  if (!response.ok) {
    return {
      files: [],
      incomplete: true,
      diff: `gitlab-mr:${options.url.canonicalUrl}`,
    };
  }
  const payload = (await response.json()) as {
    readonly changes?: readonly GitLabChange[];
  };
  const changes = payload.changes ?? [];
  const patches = changes
    .slice(0, 50)
    .map((row) => row.diff)
    .filter((value): value is string => typeof value === "string");
  return {
    files: changes
      .slice(0, MAX_FORGE_FILES)
      .map(snapshotFile)
      .filter((file): file is SnapshotFile => file !== undefined),
    incomplete: changes.length >= MAX_FORGE_FILES,
    diff:
      patches.length === 0
        ? `gitlab-mr:${options.url.canonicalUrl}`
        : patches.join("\n").slice(0, 512 * 1024),
  };
}

export class GitLabForgeReader implements ForgeReader {
  async read(
    url: ParsedForgeUrl,
    credentials: ForgeCredentials,
    transport: ForgeTransport,
  ): Promise<ForgeReadResult> {
    const headers = requestHeaders(credentials);
    const project = encodeURIComponent(`${url.owner}/${url.repository}`);
    const api = `https://gitlab.com/api/v4/projects/${project}/merge_requests/${String(url.number)}`;
    const response = await transport.fetch(api, { headers });
    if (!response.ok) {
      throw new Error(
        `GitLab API request failed with status ${String(response.status)}`,
      );
    }
    const body = (await response.json()) as GitLabMergeRequest;
    const baseSha = body.diff_refs?.base_sha ?? "";
    const headSha = body.diff_refs?.head_sha ?? "";
    if (!/^[0-9a-f]{40}$/u.test(baseSha) || !/^[0-9a-f]{40}$/u.test(headSha)) {
      throw new Error("GitLab merge request revisions are invalid");
    }
    const cloneUrl = `https://gitlab.com/${url.owner}/${url.repository}.git`;
    const [headCloneUrl, changes] = await Promise.all([
      resolveHeadCloneUrl({ mergeRequest: body, cloneUrl, headers, transport }),
      readChanges({ api, headers, url, transport }),
    ]);

    const snapshot = createReviewSnapshot({
      inputKind: "gitlab_mr",
      scope: "change",
      repository: `${url.owner}/${url.repository}`,
      comparisonBase: baseSha,
      head: headSha,
      files: changes.files,
      exclusions: [],
      incomplete: changes.incomplete,
      diff: changes.diff,
    });
    return {
      url,
      metadata: {
        title: body.title ?? "",
        description: body.description ?? "",
        baseSha,
        headSha,
        cloneUrl,
        headCloneUrl,
        ...(body.author?.username === undefined
          ? {}
          : { author: body.author.username }),
      },
      snapshot,
    };
  }
}
