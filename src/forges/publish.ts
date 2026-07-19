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
