import { agentDiagnostic } from "./agent-diagnostic.js";
import { retainSmallest } from "./bounded-selection.js";
import type { ValidationDiagnostic } from "./validation.js";

export const DEFAULT_MAX_DIAGNOSTICS = 1_000;
export const HARD_MAX_DIAGNOSTICS = 5_000;

interface StoredDiagnostic {
  readonly diagnostic: ValidationDiagnostic;
  readonly sequence: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareStored(
  left: StoredDiagnostic,
  right: StoredDiagnostic,
): number {
  const pathOrder = compareText(left.diagnostic.path, right.diagnostic.path);
  if (pathOrder !== 0) {
    return pathOrder;
  }
  const codeOrder = compareText(left.diagnostic.code, right.diagnostic.code);
  return codeOrder === 0 ? left.sequence - right.sequence : codeOrder;
}

export class BoundedDiagnosticCollector {
  readonly #maximum: number;
  readonly #retained: StoredDiagnostic[] = [];
  #nextSequence = 0;
  #truncated = false;

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  add(...diagnostics: readonly ValidationDiagnostic[]): void {
    for (const diagnostic of diagnostics) {
      if (diagnostic.code === "DIAGNOSTIC_LIMIT_EXCEEDED") {
        this.#truncated = true;
        continue;
      }
      const stored = { diagnostic, sequence: this.#nextSequence };
      this.#nextSequence += 1;
      const omitted = retainSmallest(
        this.#retained,
        stored,
        this.#maximum,
        compareStored,
      );
      if (omitted !== undefined) {
        this.#truncated = true;
      }
    }
  }

  toArray(): ValidationDiagnostic[] {
    const sorted = [...this.#retained].sort(compareStored);
    if (!this.#truncated) {
      return sorted.map((item) => item.diagnostic);
    }
    const retainedCount = Math.max(0, this.#maximum - 1);
    return [
      ...sorted.slice(0, retainedCount).map((item) => item.diagnostic),
      agentDiagnostic(
        "DIAGNOSTIC_LIMIT_EXCEEDED",
        "incomplete",
        ".",
        `Diagnostic limit of ${String(this.#maximum)} was exceeded; additional evidence was omitted`,
      ),
    ];
  }
}
