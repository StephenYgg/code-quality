import { describe, expect, test } from "vitest";

import { GitHubForgeReader } from "../../../src/forges/github.js";
import { parseForgeUrl } from "../../../src/forges/url.js";

describe("GitHub forge file enrichment", () => {
  test("maps pull request files into the snapshot", async () => {
    const reader = new GitHubForgeReader();
    const url = parseForgeUrl("https://github.com/acme/app/pull/8");
    const result = await reader.read(
      url,
      {},
      {
        fetch(input: string | URL | Request) {
          const href =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (href.endsWith("/files?per_page=100")) {
            return Promise.resolve(
              new Response(
                JSON.stringify([
                  {
                    filename: "src/a.ts",
                    status: "modified",
                    additions: 2,
                    deletions: 1,
                    patch: "@@ -1 +1 @@\n-a\n+b\n",
                  },
                ]),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                title: "demo",
                body: "desc",
                base: { sha: "a".repeat(40) },
                head: { sha: "b".repeat(40) },
                changed_files: 1,
              }),
              { status: 200 },
            ),
          );
        },
      },
    );
    expect(result.snapshot.files).toEqual([
      expect.objectContaining({ path: "src/a.ts", status: "modified" }),
    ]);
    expect(result.snapshot.diff).toContain("+b");
  });

  test("authenticates every read and returns trusted base and fork clone URLs", async () => {
    const reader = new GitHubForgeReader();
    const url = parseForgeUrl("https://github.com/acme/app/pull/8");
    const authorizations: (string | null)[] = [];
    const result = await reader.read(
      url,
      { token: "private-read-token" },
      {
        fetch(input: string | URL | Request, init?: RequestInit) {
          authorizations.push(new Headers(init?.headers).get("authorization"));
          const href =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          return Promise.resolve(
            new Response(
              JSON.stringify(
                href.includes("/files?")
                  ? []
                  : {
                      title: "private fork",
                      body: "",
                      base: {
                        sha: "a".repeat(40),
                        repo: { clone_url: "https://github.com/acme/app.git" },
                      },
                      head: {
                        sha: "b".repeat(40),
                        repo: {
                          clone_url: "https://github.com/contributor/app.git",
                        },
                      },
                      changed_files: 0,
                    },
              ),
              { status: 200 },
            ),
          );
        },
      },
    );

    expect(authorizations).toEqual([
      "Bearer private-read-token",
      "Bearer private-read-token",
    ]);
    expect(result.metadata.cloneUrl).toBe("https://github.com/acme/app.git");
    expect(result.metadata.headCloneUrl).toBe(
      "https://github.com/contributor/app.git",
    );
  });
});
