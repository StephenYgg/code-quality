import { createHash } from "node:crypto";

import {
  createReviewSnapshot,
  MAX_SNAPSHOT_EXCLUSIONS,
  type ReviewSnapshot,
  type SnapshotExclusion,
} from "./snapshots.js";

export interface ImmutableReviewInput {
  readonly snapshot: ReviewSnapshot;
  readonly contentByPath: ReadonlyMap<string, Buffer>;
  readonly contentBundleHash: string;
}

class CapturedContentMap implements ReadonlyMap<string, Buffer> {
  readonly #content: Map<string, Buffer>;

  constructor(entries: Iterable<readonly [string, Buffer]>) {
    this.#content = ownContent(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#content.size;
  }

  get(path: string): Buffer | undefined {
    const value = this.#content.get(path);
    return value === undefined ? undefined : Buffer.from(value);
  }

  has(path: string): boolean {
    return this.#content.has(path);
  }

  forEach(
    callback: (
      value: Buffer,
      key: string,
      map: ReadonlyMap<string, Buffer>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [path, bytes] of this.#content) {
      callback.call(thisArg, Buffer.from(bytes), path, this);
    }
  }

  *entries(): MapIterator<[string, Buffer]> {
    for (const [path, bytes] of this.#content) {
      yield [path, Buffer.from(bytes)];
    }
  }

  keys(): MapIterator<string> {
    return this.#content.keys();
  }

  *values(): MapIterator<Buffer> {
    for (const bytes of this.#content.values()) yield Buffer.from(bytes);
  }

  [Symbol.iterator](): MapIterator<[string, Buffer]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "CapturedContentMap";
  }
}

function ownContent(
  entries: Iterable<readonly [string, Buffer]>,
): Map<string, Buffer> {
  const sorted = [...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const owned = new Map<string, Buffer>();
  for (const [path, bytes] of sorted) {
    if (owned.has(path))
      throw new Error("Review content contains a duplicate path");
    if (!Buffer.isBuffer(bytes))
      throw new Error("Review content must use Buffer values");
    owned.set(path, Buffer.from(bytes));
  }
  return owned;
}

function hashContent(content: ReadonlyMap<string, Buffer>): string {
  const hash = createHash("sha256").update("cq-review-content-bundle/v1\0");
  for (const [path, bytes] of content) {
    hash.update(`${Buffer.byteLength(path, "utf8").toString()}:`);
    hash.update(path, "utf8");
    hash.update(`${bytes.length.toString()}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function validateContentSet(
  snapshot: ReviewSnapshot,
  content: ReadonlyMap<string, Buffer>,
): void {
  const fileByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  if (fileByPath.size !== snapshot.files.length) {
    throw new Error("Review snapshot contains duplicate file paths");
  }
  const excludedPaths = new Set(
    snapshot.exclusions.flatMap((exclusion) =>
      exclusion.path === undefined ? [] : [exclusion.path],
    ),
  );
  const eligiblePaths = new Set(
    snapshot.files
      .filter(
        (file) =>
          file.status !== "deleted" &&
          !file.binary &&
          !excludedPaths.has(file.path),
      )
      .map((file) => file.path),
  );

  for (const path of content.keys()) {
    if (!fileByPath.has(path)) {
      throw new Error(`Review content path is outside the snapshot: ${path}`);
    }
    if (!eligiblePaths.has(path)) {
      throw new Error(`Review content path is not eligible: ${path}`);
    }
  }
  for (const path of eligiblePaths) {
    if (!content.has(path)) {
      throw new Error(`Review content is missing bytes for ${path}`);
    }
  }
}

export function createImmutableReviewInput(
  snapshot: ReviewSnapshot,
  entries: Iterable<readonly [string, Buffer]>,
): ImmutableReviewInput {
  const contentByPath = new CapturedContentMap(entries);
  validateContentSet(snapshot, contentByPath);
  const contentBundleHash = hashContent(contentByPath);
  return Object.freeze({
    snapshot,
    contentByPath,
    contentBundleHash,
    toJSON(): never {
      throw new Error("ImmutableReviewInput is not serializable");
    },
  });
}

export function createMetadataOnlyReviewInput(
  snapshot: ReviewSnapshot,
): ImmutableReviewInput {
  const eligiblePaths = new Set(
    snapshot.files
      .filter((file) => file.status !== "deleted" && !file.binary)
      .map((file) => file.path),
  );
  const coverageByPath = new Map<string, SnapshotExclusion>();
  for (const exclusion of snapshot.exclusions) {
    if (
      exclusion.path !== undefined &&
      eligiblePaths.has(exclusion.path) &&
      !coverageByPath.has(exclusion.path)
    ) {
      coverageByPath.set(exclusion.path, exclusion);
    }
  }
  const requiredExclusions: SnapshotExclusion[] = [];
  for (const path of eligiblePaths) {
    requiredExclusions.push(
      coverageByPath.get(path) ?? { path, reason: "unsupported" },
    );
  }
  const requiredSet = new Set(requiredExclusions);
  const optionalExclusions = snapshot.exclusions.filter(
    (exclusion) => !requiredSet.has(exclusion),
  );
  const exclusions = [
    ...requiredExclusions,
    ...optionalExclusions.slice(
      0,
      MAX_SNAPSHOT_EXCLUSIONS - requiredExclusions.length,
    ),
  ];
  const normalized = createReviewSnapshot({
    inputKind: snapshot.inputKind,
    scope: snapshot.scope,
    repository: snapshot.repository,
    ...(snapshot.comparisonBase === undefined
      ? {}
      : { comparisonBase: snapshot.comparisonBase }),
    head: snapshot.head,
    files: snapshot.files,
    ...(snapshot.diff === undefined ? {} : { diff: snapshot.diff }),
    exclusions,
    incomplete: true,
  });
  return createImmutableReviewInput(normalized, []);
}
