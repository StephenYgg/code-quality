import { describe, expect, test } from "vitest";

import { parseForgeUrl, ForgeUrlError } from "../../../src/forges/url.js";
import {
  publicationMarker,
  selectPublicationAction,
} from "../../../src/forges/publish.js";

describe("forge URLs", () => {
  test("parses GitHub and GitLab canonical URLs", () => {
    expect(parseForgeUrl("https://github.com/acme/app/pull/12")).toMatchObject({
      kind: "github",
      owner: "acme",
      repository: "app",
      number: 12,
    });
    expect(
      parseForgeUrl("https://gitlab.com/group/sub/project/-/merge_requests/9"),
    ).toMatchObject({
      kind: "gitlab",
      owner: "group/sub",
      repository: "project",
      number: 9,
    });
  });

  test("rejects unsafe URL shapes", () => {
    expect(() => parseForgeUrl("http://github.com/a/b/pull/1")).toThrow(
      ForgeUrlError,
    );
    expect(() =>
      parseForgeUrl("https://user:pass@github.com/a/b/pull/1"),
    ).toThrow(ForgeUrlError);
    expect(() => parseForgeUrl("https://example.com/a/b/pull/1")).toThrow(
      ForgeUrlError,
    );
  });

  test("publication markers are idempotent by identity", () => {
    const target = {
      forge: "github" as const,
      repository: "acme/app",
      number: 1,
      headSha: "a".repeat(40),
      reportHash: "b".repeat(64),
    };
    const marker = publicationMarker(target);
    expect(selectPublicationAction({ target })).toBe("created");
    expect(selectPublicationAction({ target, existingMarker: marker })).toBe(
      "reused",
    );
  });
});
