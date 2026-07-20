import { describe, expect, test } from "vitest";

import { GitLabForgeReader } from "../../../src/forges/gitlab.js";
import { parseForgeUrl } from "../../../src/forges/url.js";

describe("GitLab forge reader", () => {
  test("authenticates every private fork read and returns trusted clone URLs", async () => {
    const reader = new GitLabForgeReader();
    const url = parseForgeUrl("https://gitlab.com/acme/app/-/merge_requests/8");
    const tokens: (string | null)[] = [];
    const result = await reader.read(
      url,
      { token: "private-read-token" },
      {
        fetch(input: string | URL | Request, init?: RequestInit) {
          tokens.push(new Headers(init?.headers).get("private-token"));
          const href =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (href.endsWith("/changes")) {
            return Promise.resolve(
              new Response(JSON.stringify({ changes: [] }), { status: 200 }),
            );
          }
          if (href.endsWith("/projects/22")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  http_url_to_repo: "https://gitlab.com/contributor/app.git",
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                title: "private fork",
                description: "",
                diff_refs: {
                  base_sha: "a".repeat(40),
                  head_sha: "b".repeat(40),
                },
                target_project_id: 11,
                source_project_id: 22,
              }),
              { status: 200 },
            ),
          );
        },
      },
    );

    expect(tokens).toEqual([
      "private-read-token",
      "private-read-token",
      "private-read-token",
    ]);
    expect(result.metadata.cloneUrl).toBe("https://gitlab.com/acme/app.git");
    expect(result.metadata.headCloneUrl).toBe(
      "https://gitlab.com/contributor/app.git",
    );
  });
});
