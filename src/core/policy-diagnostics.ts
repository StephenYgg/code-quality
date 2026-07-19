import { compareCodeUnits } from "./deterministic-order.js";
import type { PolicyDiagnostic } from "./policy-types.js";

export const MAX_POLICY_DIAGNOSTICS_PER_DOCUMENT = 100;
export const MAX_POLICY_DIAGNOSTICS_PER_RESOLUTION = 500;

export function diagnosticLimitNotice(source: string): PolicyDiagnostic {
  return {
    code: "DIAGNOSTIC_LIMIT_EXCEEDED",
    source,
    path: "",
    message:
      "Additional policy diagnostics were omitted after reaching a hard limit",
  };
}

function compareDiagnostics(
  left: PolicyDiagnostic,
  right: PolicyDiagnostic,
): number {
  return (
    compareCodeUnits(left.source, right.source) ||
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.code, right.code) ||
    compareCodeUnits(left.message, right.message)
  );
}

export class PolicyDiagnosticCollector {
  readonly #diagnostics: PolicyDiagnostic[] = [];
  #exhausted = false;
  #hasLimitNotice = false;

  get hasDiagnostics(): boolean {
    return this.#diagnostics.length > 0;
  }

  get exhausted(): boolean {
    return this.#exhausted;
  }

  add(diagnostics: readonly PolicyDiagnostic[]): boolean {
    if (this.#exhausted) {
      return false;
    }
    for (const diagnostic of diagnostics) {
      if (diagnostic.code === "DIAGNOSTIC_LIMIT_EXCEEDED") {
        if (!this.#hasLimitNotice) {
          if (
            this.#diagnostics.length === MAX_POLICY_DIAGNOSTICS_PER_RESOLUTION
          ) {
            this.#diagnostics.pop();
            this.#exhausted = true;
          }
          this.#diagnostics.push(diagnostic);
          this.#hasLimitNotice = true;
        }
        continue;
      }
      if (this.#diagnostics.length === MAX_POLICY_DIAGNOSTICS_PER_RESOLUTION) {
        this.#exhausted = true;
        if (!this.#hasLimitNotice) {
          this.#diagnostics.pop();
          this.#diagnostics.push(diagnosticLimitNotice("effective-policy"));
          this.#hasLimitNotice = true;
        }
        break;
      }
      this.#diagnostics.push(diagnostic);
    }
    return !this.#exhausted;
  }

  toArray(): readonly PolicyDiagnostic[] {
    return [...this.#diagnostics].sort(compareDiagnostics);
  }
}
