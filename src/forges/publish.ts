import type { ForgeCredentials, ForgeTransport } from "./forge.js";
import {
  createPublicationCommentClient,
  PublicationCommentError,
  type PublicationComment,
  type PublicationCommentClient,
} from "./publication-comments.js";
import {
  PublicationLaneError,
  withPublicationLane,
} from "./publication-lane.js";
import type { ParsedForgeUrl } from "./url.js";

const MAX_PUBLICATION_BODY_BYTES = 512 * 1024;
const MAX_PUBLICATION_ATTEMPTS = 2;

export interface PublicationTarget {
  readonly forge: "github" | "gitlab";
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly reportHash: string;
}

export interface PublicationResult {
  readonly action: "created" | "updated" | "reused";
  readonly marker: string;
  readonly targetId: string;
}

export class PublicationError extends Error {
  constructor(
    readonly code:
      | "PUBLICATION_UNAUTHORIZED"
      | "PUBLICATION_STALE_HEAD"
      | "PUBLICATION_FAILED"
      | "PUBLICATION_DISABLED",
    message: string,
  ) {
    super(message);
    this.name = "PublicationError";
  }
}

export function publicationIdentity(target: PublicationTarget): string {
  return [
    target.forge,
    target.repository,
    String(target.number),
    target.headSha,
    target.reportHash,
  ].join(":");
}

export function publicationMarker(target: PublicationTarget): string {
  return `<!-- cq-report:${publicationIdentity(target)} -->`;
}

export function selectPublicationAction(options: {
  readonly existingMarker?: string;
  readonly target: PublicationTarget;
}): PublicationResult["action"] {
  const expected = publicationMarker(options.target);
  if (options.existingMarker === undefined) return "created";
  if (options.existingMarker === expected) return "reused";
  return "updated";
}

export function buildPublicationBody(options: {
  readonly target: PublicationTarget;
  readonly reportText: string;
}): string {
  const marker = publicationMarker(options.target);
  return `${marker}\n\n${options.reportText.trim()}\n`;
}

function publicationScope(target: PublicationTarget): string {
  return [target.forge, target.repository, String(target.number)].join(":");
}

function scopeMarkerPrefix(target: PublicationTarget): string {
  return `<!-- cq-report:${publicationScope(target)}:`;
}

function markerLine(comment: PublicationComment): string | undefined {
  return comment.body
    .split(/\r?\n/u)
    .find(
      (line) => line.startsWith("<!-- cq-report:") && line.endsWith(" -->"),
    );
}

function scopedComments(
  comments: readonly PublicationComment[],
  target: PublicationTarget,
): readonly PublicationComment[] {
  const prefix = scopeMarkerPrefix(target);
  return comments
    .filter((comment) => markerLine(comment)?.startsWith(prefix) === true)
    .sort((left, right) => {
      const leftId = BigInt(left.id);
      const rightId = BigInt(right.id);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}

function exactComments(
  comments: readonly PublicationComment[],
  target: PublicationTarget,
): readonly PublicationComment[] {
  const expected = publicationMarker(target);
  return scopedComments(comments, target).filter(
    (comment) => markerLine(comment) === expected,
  );
}

async function createWithReconciliation(options: {
  readonly client: PublicationCommentClient;
  readonly target: PublicationTarget;
  readonly body: string;
  readonly marker: string;
}): Promise<PublicationResult> {
  for (let attempt = 1; attempt <= MAX_PUBLICATION_ATTEMPTS; attempt += 1) {
    let createdId: string;
    try {
      createdId = await options.client.create(options.body);
    } catch (error) {
      const existing = exactComments(
        await options.client.list(),
        options.target,
      )[0];
      if (existing !== undefined) {
        return {
          action: "reused",
          marker: options.marker,
          targetId: existing.id,
        };
      }
      if (attempt < MAX_PUBLICATION_ATTEMPTS) continue;
      throw error;
    }

    const winner = exactComments(
      await options.client.list(),
      options.target,
    )[0];
    if (winner !== undefined && winner.id !== createdId) {
      await options.client.delete(createdId);
      return {
        action: "reused",
        marker: options.marker,
        targetId: winner.id,
      };
    }
    return {
      action: "created",
      marker: options.marker,
      targetId: createdId,
    };
  }
  throw new PublicationCommentError("Forge comment creation was not attempted");
}

async function updateWithReconciliation(options: {
  readonly client: PublicationCommentClient;
  readonly existing: PublicationComment;
  readonly target: PublicationTarget;
  readonly body: string;
  readonly marker: string;
}): Promise<PublicationResult> {
  for (let attempt = 1; attempt <= MAX_PUBLICATION_ATTEMPTS; attempt += 1) {
    try {
      await options.client.update(options.existing.id, options.body);
      return {
        action: "updated",
        marker: options.marker,
        targetId: options.existing.id,
      };
    } catch (error) {
      const reconciled = exactComments(
        await options.client.list(),
        options.target,
      )[0];
      if (reconciled !== undefined) {
        return {
          action: "updated",
          marker: options.marker,
          targetId: reconciled.id,
        };
      }
      if (attempt < MAX_PUBLICATION_ATTEMPTS) continue;
      throw error;
    }
  }
  throw new PublicationCommentError("Forge comment update was not attempted");
}

async function publishOnce(options: {
  readonly client: PublicationCommentClient;
  readonly target: PublicationTarget;
  readonly body: string;
  readonly marker: string;
}): Promise<PublicationResult> {
  const existing = await options.client.list();
  const exact = exactComments(existing, options.target)[0];
  if (exact !== undefined) {
    return { action: "reused", marker: options.marker, targetId: exact.id };
  }
  const scoped = scopedComments(existing, options.target)[0];
  if (scoped !== undefined) {
    return updateWithReconciliation({ ...options, existing: scoped });
  }
  return createWithReconciliation(options);
}

export async function publishReviewComment(options: {
  readonly url: ParsedForgeUrl;
  readonly target: PublicationTarget;
  readonly reportText: string;
  readonly credentials: ForgeCredentials;
  readonly transport: ForgeTransport;
  readonly currentHeadSha: string;
}): Promise<PublicationResult> {
  if (options.currentHeadSha !== options.target.headSha) {
    throw new PublicationError(
      "PUBLICATION_STALE_HEAD",
      "Publication refused because the forge head SHA changed",
    );
  }
  const token = options.credentials.token;
  if (token === undefined || token.length === 0) {
    throw new PublicationError(
      "PUBLICATION_UNAUTHORIZED",
      "Publication credentials are not set",
    );
  }
  const marker = publicationMarker(options.target);
  const body = buildPublicationBody({
    target: options.target,
    reportText: options.reportText,
  });
  if (Buffer.byteLength(body, "utf8") > MAX_PUBLICATION_BODY_BYTES) {
    throw new PublicationError(
      "PUBLICATION_FAILED",
      "Publication body exceeded its hard byte limit",
    );
  }
  const client = createPublicationCommentClient({
    url: options.url,
    token,
    transport: options.transport,
  });
  try {
    return await withPublicationLane(publicationScope(options.target), () =>
      publishOnce({ client, target: options.target, body, marker }),
    );
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    if (
      error instanceof PublicationCommentError ||
      error instanceof PublicationLaneError
    ) {
      throw new PublicationError("PUBLICATION_FAILED", error.message);
    }
    throw new PublicationError("PUBLICATION_FAILED", "Publication failed");
  }
}
