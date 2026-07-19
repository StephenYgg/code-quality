import type { ReviewSnapshot } from "../core/snapshots.js";
import type { ParsedForgeUrl } from "./url.js";

export interface ForgeChangeMetadata {
  readonly title: string;
  readonly description: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly author?: string;
}

export interface ForgeReadResult {
  readonly url: ParsedForgeUrl;
  readonly metadata: ForgeChangeMetadata;
  readonly snapshot: ReviewSnapshot;
}

export interface ForgeTransport {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface ForgeCredentials {
  readonly tokenEnv?: string;
}

export interface ForgeReader {
  read(
    url: ParsedForgeUrl,
    credentials: ForgeCredentials,
    transport: ForgeTransport,
  ): Promise<ForgeReadResult>;
}
