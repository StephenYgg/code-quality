export type DataClassification =
  "public" | "internal" | "confidential" | "restricted";

export type EgressClass = "local" | "loopback" | "https";

export class EgressError extends Error {
  constructor(
    readonly code: "EGRESS_DENIED",
    message: string,
  ) {
    super(message);
    this.name = "EgressError";
  }
}

/**
 * Repository content may only leave the machine according to classification.
 * - public/internal: local process or HTTPS trusted endpoints
 * - confidential: local process adapters only (Codex/Claude CLI)
 * - restricted: local process adapters only, no loopback HTTP either
 */
export function assertEgressAllowed(
  classification: DataClassification,
  egressClass: EgressClass,
  providerClass: string,
): void {
  if (classification === "public" || classification === "internal") {
    return;
  }
  if (classification === "confidential") {
    if (egressClass === "local") return;
    throw new EgressError(
      "EGRESS_DENIED",
      `Confidential repository content cannot use provider class ${providerClass} with egress ${egressClass}`,
    );
  }
  // restricted
  if (egressClass === "local") return;
  throw new EgressError(
    "EGRESS_DENIED",
    `Restricted repository content cannot leave the local process boundary (provider=${providerClass}, egress=${egressClass})`,
  );
}
