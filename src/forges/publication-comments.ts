import type { ForgeTransport } from "./forge.js";
import type { ParsedForgeUrl } from "./url.js";

const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 5;
const MAX_COMMENT_RESPONSE_BYTES = 1024 * 1024;

export interface PublicationComment {
  readonly id: string;
  readonly body: string;
}

export class PublicationCommentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationCommentError";
  }
}

export interface PublicationCommentClient {
  list(): Promise<readonly PublicationComment[]>;
  create(body: string): Promise<string>;
  update(id: string, body: string): Promise<void>;
  delete(id: string): Promise<void>;
}

function assertCommentId(value: unknown): string {
  const id = typeof value === "number" ? String(value) : value;
  if (typeof id !== "string" || !/^[0-9]{1,32}$/u.test(id)) {
    throw new PublicationCommentError("Forge comment ID is invalid");
  }
  return id;
}

async function responseJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_RESPONSE_BYTES) {
    throw new PublicationCommentError(
      "Forge comment response exceeded its hard byte limit",
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new PublicationCommentError("Forge comment response is not JSON");
  }
}

function normalizeComment(value: unknown): PublicationComment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicationCommentError("Forge comment row is invalid");
  }
  const row = value as { readonly id?: unknown; readonly body?: unknown };
  if (typeof row.body !== "string") {
    throw new PublicationCommentError("Forge comment body is invalid");
  }
  return Object.freeze({ id: assertCommentId(row.id), body: row.body });
}

function commentUrls(url: ParsedForgeUrl): {
  readonly collection: string;
  readonly member: (id: string) => string;
} {
  if (url.kind === "github") {
    const repository = `https://api.github.com/repos/${url.owner}/${url.repository}`;
    return {
      collection: `${repository}/issues/${String(url.number)}/comments`,
      member: (id) => `${repository}/issues/comments/${id}`,
    };
  }
  const project = encodeURIComponent(`${url.owner}/${url.repository}`);
  const mergeRequest = `https://gitlab.com/api/v4/projects/${project}/merge_requests/${String(url.number)}`;
  return {
    collection: `${mergeRequest}/notes`,
    member: (id) => `${mergeRequest}/notes/${id}`,
  };
}

function commentHeaders(
  url: ParsedForgeUrl,
  token: string,
): Readonly<Record<string, string>> {
  return url.kind === "github"
    ? {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "code-quality-cli",
        "Content-Type": "application/json",
      }
    : {
        Accept: "application/json",
        "PRIVATE-TOKEN": token,
        "User-Agent": "code-quality-cli",
        "Content-Type": "application/json",
      };
}

async function requireSuccess(
  operation: string,
  request: Promise<Response>,
): Promise<Response> {
  let response: Response;
  try {
    response = await request;
  } catch {
    throw new PublicationCommentError(`${operation} did not complete`);
  }
  if (!response.ok) {
    throw new PublicationCommentError(
      `${operation} failed with status ${String(response.status)}`,
    );
  }
  return response;
}

export function createPublicationCommentClient(options: {
  readonly url: ParsedForgeUrl;
  readonly token: string;
  readonly transport: ForgeTransport;
}): PublicationCommentClient {
  const urls = commentUrls(options.url);
  const headers = commentHeaders(options.url, options.token);
  return Object.freeze({
    async list(): Promise<readonly PublicationComment[]> {
      const comments: PublicationComment[] = [];
      for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
        const response = await requireSuccess(
          "Forge comment listing",
          options.transport.fetch(
            `${urls.collection}?per_page=${String(COMMENTS_PER_PAGE)}&page=${String(page)}`,
            { headers },
          ),
        );
        const payload = await responseJson(response);
        if (!Array.isArray(payload) || payload.length > COMMENTS_PER_PAGE) {
          throw new PublicationCommentError(
            "Forge comment page shape is invalid",
          );
        }
        comments.push(...payload.map(normalizeComment));
        if (payload.length < COMMENTS_PER_PAGE) {
          return Object.freeze(comments);
        }
      }
      throw new PublicationCommentError(
        "Forge comment listing exceeded its hard page limit",
      );
    },

    async create(body: string): Promise<string> {
      const response = await requireSuccess(
        "Forge comment creation",
        options.transport.fetch(urls.collection, {
          method: "POST",
          headers,
          body: JSON.stringify({ body }),
        }),
      );
      const payload = (await responseJson(response)) as {
        readonly id?: unknown;
      };
      return assertCommentId(payload.id);
    },

    async update(id: string, body: string): Promise<void> {
      await requireSuccess(
        "Forge comment update",
        options.transport.fetch(urls.member(assertCommentId(id)), {
          method: options.url.kind === "github" ? "PATCH" : "PUT",
          headers,
          body: JSON.stringify({ body }),
        }),
      );
    },

    async delete(id: string): Promise<void> {
      await requireSuccess(
        "Forge duplicate comment deletion",
        options.transport.fetch(urls.member(assertCommentId(id)), {
          method: "DELETE",
          headers,
        }),
      );
    },
  });
}
