import { createReviewSnapshot } from "../core/snapshots.js";
import type {
  ForgeCredentials,
  ForgeReadResult,
  ForgeReader,
  ForgeTransport,
} from "./forge.js";
import type { ParsedForgeUrl } from "./url.js";

export class GitHubForgeReader implements ForgeReader {
  async read(
    url: ParsedForgeUrl,
    credentials: ForgeCredentials,
    transport: ForgeTransport,
  ): Promise<ForgeReadResult> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "code-quality-cli",
    };
    if (credentials.tokenEnv !== undefined) {
      const token = process.env[credentials.tokenEnv];
      if (token !== undefined && token.length > 0) {
        headers.Authorization = `Bearer ${token}`;
      }
    }
    const api = `https://api.github.com/repos/${url.owner}/${url.repository}/pulls/${String(url.number)}`;
    const response = await transport.fetch(api, { headers });
    if (!response.ok) {
      throw new Error(
        `GitHub API request failed with status ${String(response.status)}`,
      );
    }
    const body = (await response.json()) as {
      readonly title?: string;
      readonly body?: string | null;
      readonly base?: { readonly sha?: string };
      readonly head?: { readonly sha?: string };
      readonly user?: { readonly login?: string };
      readonly changed_files?: number;
    };
    const baseSha = body.base?.sha ?? "";
    const headSha = body.head?.sha ?? "";
    if (!/^[0-9a-f]{40}$/u.test(baseSha) || !/^[0-9a-f]{40}$/u.test(headSha)) {
      throw new Error("GitHub pull request revisions are invalid");
    }
    const snapshot = createReviewSnapshot({
      inputKind: "github_pr",
      scope: "change",
      repository: `${url.owner}/${url.repository}`,
      comparisonBase: baseSha,
      head: headSha,
      files: [],
      exclusions: [],
      // File bodies are fetched in a later enrichment stage.
      incomplete: true,
      diff: `github-pr:${url.canonicalUrl}`,
    });
    return {
      url,
      metadata: {
        title: body.title ?? "",
        description: body.body ?? "",
        baseSha,
        headSha,
        ...(body.user?.login === undefined ? {} : { author: body.user.login }),
      },
      snapshot,
    };
  }
}
