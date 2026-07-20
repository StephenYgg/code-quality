import type { ReviewSnapshot } from "../core/snapshots.js";
import type { MaterializedForgeCheckout } from "./materialize.js";
import type { ParsedForgeUrl } from "./url.js";

export interface ForgeChangeMetadata {
  readonly title: string;
  readonly description: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly author?: string;
  readonly cloneUrl?: string;
  readonly headCloneUrl?: string;
}

export interface ForgeReadResult {
  readonly url: ParsedForgeUrl;
  readonly metadata: ForgeChangeMetadata;
  readonly snapshot: ReviewSnapshot;
  readonly materialization?: MaterializedForgeCheckout;
}

export interface ForgeTransport {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface ForgeCredentials {
  readonly token?: string;
}

export function resolveForgeCredentials(
  tokenEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): ForgeCredentials {
  const token = env[tokenEnv];
  return token === undefined || token.length === 0
    ? Object.freeze({})
    : Object.freeze({ token });
}

export function trustedForgeCloneUrl(
  value: unknown,
  kind: ParsedForgeUrl["kind"],
): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const expectedHost = kind === "github" ? "github.com" : "gitlab.com";
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== expectedHost ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !url.pathname.endsWith(".git")
    ) {
      return undefined;
    }
    return `https://${expectedHost}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export interface ForgeReader {
  read(
    url: ParsedForgeUrl,
    credentials: ForgeCredentials,
    transport: ForgeTransport,
  ): Promise<ForgeReadResult>;
}
