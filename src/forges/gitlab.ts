import { createReviewSnapshot } from "../core/snapshots.js";
import type {
  ForgeCredentials,
  ForgeReadResult,
  ForgeReader,
  ForgeTransport,
} from "./forge.js";
import type { ParsedForgeUrl } from "./url.js";

export class GitLabForgeReader implements ForgeReader {
  async read(
    url: ParsedForgeUrl,
    credentials: ForgeCredentials,
    transport: ForgeTransport,
  ): Promise<ForgeReadResult> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "code-quality-cli",
    };
    if (credentials.tokenEnv !== undefined) {
      const token = process.env[credentials.tokenEnv];
      if (token !== undefined && token.length > 0) {
        headers["PRIVATE-TOKEN"] = token;
      }
    }
    const project = encodeURIComponent(`${url.owner}/${url.repository}`);
    const api = `https://gitlab.com/api/v4/projects/${project}/merge_requests/${String(url.number)}`;
    const response = await transport.fetch(api, { headers });
    if (!response.ok) {
      throw new Error(
        `GitLab API request failed with status ${String(response.status)}`,
      );
    }
    const body = (await response.json()) as {
      readonly title?: string;
      readonly description?: string | null;
      readonly diff_refs?: {
        readonly base_sha?: string;
        readonly head_sha?: string;
      };
      readonly author?: { readonly username?: string };
      readonly changes_count?: string;
    };
    const baseSha = body.diff_refs?.base_sha ?? "";
    const headSha = body.diff_refs?.head_sha ?? "";
    if (!/^[0-9a-f]{40}$/u.test(baseSha) || !/^[0-9a-f]{40}$/u.test(headSha)) {
      throw new Error("GitLab merge request revisions are invalid");
    }
    const snapshot = createReviewSnapshot({
      inputKind: "gitlab_mr",
      scope: "change",
      repository: `${url.owner}/${url.repository}`,
      comparisonBase: baseSha,
      head: headSha,
      files: [],
      exclusions: [],
      incomplete: true,
      diff: `gitlab-mr:${url.canonicalUrl}`,
    });
    return {
      url,
      metadata: {
        title: body.title ?? "",
        description: body.description ?? "",
        baseSha,
        headSha,
        ...(body.author?.username === undefined
          ? {}
          : { author: body.author.username }),
      },
      snapshot,
    };
  }
}
