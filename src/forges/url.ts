export type ForgeKind = "github" | "gitlab";

export interface ParsedForgeUrl {
  readonly kind: ForgeKind;
  readonly host: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly canonicalUrl: string;
}

export class ForgeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeUrlError";
  }
}

export function parseForgeUrl(input: string): ParsedForgeUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ForgeUrlError("Forge URL is invalid");
  }
  if (url.protocol !== "https:") {
    throw new ForgeUrlError("Forge URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new ForgeUrlError("Forge URL must not include userinfo");
  }
  if (url.port !== "") {
    throw new ForgeUrlError("Forge URL must not include an explicit port");
  }
  if (url.hash !== "") {
    throw new ForgeUrlError("Forge URL must not include a fragment");
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);

  if (host === "github.com") {
    if (segments.length !== 4 || segments[2] !== "pull") {
      throw new ForgeUrlError(
        "GitHub PR URL must look like /owner/repo/pull/123",
      );
    }
    const number = Number(segments[3]);
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new ForgeUrlError("GitHub PR number is invalid");
    }
    const owner = segments[0] ?? "";
    const repository = segments[1] ?? "";
    return {
      kind: "github",
      host,
      owner,
      repository,
      number,
      canonicalUrl: `https://${host}/${owner}/${repository}/pull/${String(number)}`,
    };
  }

  if (host === "gitlab.com") {
    const mergeIndex = segments.indexOf("merge_requests");
    if (mergeIndex < 2 || mergeIndex !== segments.length - 2) {
      throw new ForgeUrlError(
        "GitLab MR URL must look like /group/project/-/merge_requests/123",
      );
    }
    const number = Number(segments[mergeIndex + 1]);
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new ForgeUrlError("GitLab MR number is invalid");
    }
    const projectParts = segments
      .slice(0, mergeIndex)
      .filter((part) => part !== "-");
    const repository = projectParts.at(-1) ?? "";
    const owner = projectParts.slice(0, -1).join("/");
    if (owner.length === 0 || repository.length === 0) {
      throw new ForgeUrlError("GitLab project path is invalid");
    }
    return {
      kind: "gitlab",
      host,
      owner,
      repository,
      number,
      canonicalUrl: `https://${host}/${owner}/${repository}/-/merge_requests/${String(number)}`,
    };
  }

  throw new ForgeUrlError(
    "Forge host is not trusted; configure an enterprise mapping first",
  );
}
