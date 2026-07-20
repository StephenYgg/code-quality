import { describe, expect, test } from "vitest";

import {
  publishReviewComment,
  PublicationError,
  publicationMarker,
  selectPublicationAction,
} from "../../../src/forges/publish.js";
import { parseForgeUrl } from "../../../src/forges/url.js";

function requestHref(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init: RequestInit | undefined): { readonly body: string } {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected a JSON string request body");
  }
  return JSON.parse(init.body) as { body: string };
}

describe("publication", () => {
  test("creates a comment through injected transport", async () => {
    const url = parseForgeUrl("https://github.com/acme/app/pull/3");
    const target = {
      forge: "github" as const,
      repository: "acme/app",
      number: 3,
      headSha: "a".repeat(40),
      reportHash: "b".repeat(64),
    };
    const calls: string[] = [];
    const comments: { id: number; body: string }[] = [];
    const result = await publishReviewComment({
      url,
      target,
      reportText: "Gate: PASS",
      credentials: { token: "token-value" },
      currentHeadSha: "a".repeat(40),
      transport: {
        fetch(input: string | URL | Request, init?: RequestInit) {
          const href =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          calls.push(`${init?.method ?? "GET"} ${href}`);
          if ((init?.method ?? "GET") === "GET") {
            return Promise.resolve(
              new Response(JSON.stringify(comments), { status: 200 }),
            );
          }
          const body = requestBody(init);
          comments.push({ id: 99, body: body.body });
          return Promise.resolve(
            new Response(JSON.stringify({ id: 99 }), { status: 201 }),
          );
        },
      },
    });
    expect(result.action).toBe("created");
    expect(result.targetId).toBe("99");
    expect(calls.some((call) => call.startsWith("POST"))).toBe(true);
    expect(publicationMarker(target)).toContain("cq-report:");
  });

  test("refuses stale heads and missing tokens", async () => {
    const url = parseForgeUrl("https://github.com/acme/app/pull/3");
    const target = {
      forge: "github" as const,
      repository: "acme/app",
      number: 3,
      headSha: "a".repeat(40),
      reportHash: "b".repeat(64),
    };
    await expect(
      publishReviewComment({
        url,
        target,
        reportText: "x",
        credentials: {},
        currentHeadSha: "c".repeat(40),
        transport: {
          fetch() {
            return Promise.resolve(new Response("{}", { status: 200 }));
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "PUBLICATION_STALE_HEAD",
    } satisfies Partial<PublicationError>);
  });

  test("updates an old PASS publication when the semantic report hash changes", () => {
    const previousTarget = {
      forge: "github" as const,
      repository: "acme/app",
      number: 3,
      headSha: "a".repeat(40),
      reportHash: "b".repeat(64),
    };
    const currentTarget = {
      ...previousTarget,
      reportHash: "c".repeat(64),
    };

    expect(
      selectPublicationAction({
        existingMarker: publicationMarker(previousTarget),
        target: currentTarget,
      }),
    ).toBe("updated");
  });

  test("paginates existing comments and reuses only the exact scoped marker", async () => {
    const url = parseForgeUrl("https://github.com/acme/app/pull/3");
    const target = {
      forge: "github" as const,
      repository: "acme/app",
      number: 3,
      headSha: "a".repeat(40),
      reportHash: "b".repeat(64),
    };
    const marker = publicationMarker(target);
    const calls: string[] = [];
    const result = await publishReviewComment({
      url,
      target,
      reportText: "Gate: PASS",
      credentials: { token: "token-value" },
      currentHeadSha: target.headSha,
      transport: {
        fetch(input: string | URL | Request, init?: RequestInit) {
          const href = requestHref(input);
          calls.push(`${init?.method ?? "GET"} ${href}`);
          if (href.includes("&page=1")) {
            return Promise.resolve(
              new Response(
                JSON.stringify(
                  Array.from({ length: 100 }, (_, index) => ({
                    id: index + 1,
                    body: "<!-- cq-report:someone-else -->",
                  })),
                ),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify([{ id: 101, body: marker }]), {
              status: 200,
            }),
          );
        },
      },
    });

    expect(result).toMatchObject({ action: "reused", targetId: "101" });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.startsWith("GET"))).toBe(true);
  });

  test("reconciles an ambiguous create before issuing a retry", async () => {
    const url = parseForgeUrl("https://github.com/acme/app/pull/3");
    const target = {
      forge: "github" as const,
      repository: "acme/app",
      number: 3,
      headSha: "a".repeat(40),
      reportHash: "b".repeat(64),
    };
    const comments: { id: number; body: string }[] = [];
    let posts = 0;
    const result = await publishReviewComment({
      url,
      target,
      reportText: "Gate: PASS",
      credentials: { token: "token-value" },
      currentHeadSha: target.headSha,
      transport: {
        fetch(_input: string | URL | Request, init?: RequestInit) {
          if ((init?.method ?? "GET") === "GET") {
            return Promise.resolve(
              new Response(JSON.stringify(comments), { status: 200 }),
            );
          }
          posts += 1;
          comments.push({ id: 7, body: publicationMarker(target) });
          return Promise.resolve(new Response("{}", { status: 500 }));
        },
      },
    });

    expect(result).toMatchObject({ action: "reused", targetId: "7" });
    expect(posts).toBe(1);
  });

  test("retries a failed create once when reconciliation finds nothing", async () => {
    const url = parseForgeUrl("https://github.com/acme/app/pull/3");
    const target = {
      forge: "github" as const,
      repository: "acme/app",
      number: 3,
      headSha: "a".repeat(40),
      reportHash: "b".repeat(64),
    };
    const comments: { id: number; body: string }[] = [];
    let posts = 0;
    const result = await publishReviewComment({
      url,
      target,
      reportText: "Gate: PASS",
      credentials: { token: "token-value" },
      currentHeadSha: target.headSha,
      transport: {
        fetch(_input: string | URL | Request, init?: RequestInit) {
          if ((init?.method ?? "GET") === "GET") {
            return Promise.resolve(
              new Response(JSON.stringify(comments), { status: 200 }),
            );
          }
          posts += 1;
          if (posts === 1) {
            return Promise.resolve(new Response("{}", { status: 500 }));
          }
          const body = requestBody(init);
          comments.push({ id: 8, body: body.body });
          return Promise.resolve(
            new Response(JSON.stringify({ id: 8 }), { status: 201 }),
          );
        },
      },
    });

    expect(result).toMatchObject({ action: "created", targetId: "8" });
    expect(posts).toBe(2);
  });

  test("serializes concurrent publication for one target", async () => {
    const url = parseForgeUrl("https://github.com/acme/app/pull/3");
    const target = {
      forge: "github" as const,
      repository: "acme/app",
      number: 3,
      headSha: "a".repeat(40),
      reportHash: "b".repeat(64),
    };
    const comments: { id: number; body: string }[] = [];
    let posts = 0;
    const transport = {
      fetch(_input: string | URL | Request, init?: RequestInit) {
        if ((init?.method ?? "GET") === "GET") {
          return Promise.resolve(
            new Response(JSON.stringify(comments), { status: 200 }),
          );
        }
        posts += 1;
        const body = requestBody(init);
        comments.push({ id: 9, body: body.body });
        return Promise.resolve(
          new Response(JSON.stringify({ id: 9 }), { status: 201 }),
        );
      },
    };
    const request = {
      url,
      target,
      reportText: "Gate: PASS",
      credentials: { token: "token-value" },
      currentHeadSha: target.headSha,
      transport,
    };

    const [first, second] = await Promise.all([
      publishReviewComment(request),
      publishReviewComment(request),
    ]);

    expect(posts).toBe(1);
    expect(first.targetId).toBe("9");
    expect(second).toMatchObject({ action: "reused", targetId: "9" });
  });

  test("removes its duplicate when post-create reconciliation finds an earlier winner", async () => {
    const url = parseForgeUrl("https://github.com/acme/app/pull/3");
    const target = {
      forge: "github" as const,
      repository: "acme/app",
      number: 3,
      headSha: "a".repeat(40),
      reportHash: "b".repeat(64),
    };
    let listCount = 0;
    const methods: string[] = [];
    const result = await publishReviewComment({
      url,
      target,
      reportText: "Gate: PASS",
      credentials: { token: "token-value" },
      currentHeadSha: target.headSha,
      transport: {
        fetch(_input: string | URL | Request, init?: RequestInit) {
          const method = init?.method ?? "GET";
          methods.push(method);
          if (method === "GET") {
            listCount += 1;
            return Promise.resolve(
              new Response(
                JSON.stringify(
                  listCount === 1
                    ? []
                    : [
                        { id: 1, body: publicationMarker(target) },
                        { id: 2, body: publicationMarker(target) },
                      ],
                ),
                { status: 200 },
              ),
            );
          }
          if (method === "DELETE") {
            return Promise.resolve(new Response(null, { status: 204 }));
          }
          return Promise.resolve(
            new Response(JSON.stringify({ id: 2 }), { status: 201 }),
          );
        },
      },
    });

    expect(result).toMatchObject({ action: "reused", targetId: "1" });
    expect(methods).toContain("DELETE");
  });
});
