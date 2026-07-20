import { type ProviderUsage, ProviderError } from "./provider.js";

export interface ProviderUsageFields {
  readonly input: string;
  readonly output: string;
  readonly total?: string;
}

function invalidUsage(): never {
  throw new ProviderError(
    "PROVIDER_RESPONSE_INVALID",
    "Provider usage metadata is invalid",
  );
}

function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidUsage();
  }
  return value;
}

export function parseProviderUsage(
  value: unknown,
  fields: ProviderUsageFields,
): ProviderUsage | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidUsage();
  }
  const usage = value as Record<string, unknown>;
  const inputTokens = tokenCount(usage[fields.input]);
  const outputTokens = tokenCount(usage[fields.output]);
  const calculatedTotal = inputTokens + outputTokens;
  if (!Number.isSafeInteger(calculatedTotal)) return invalidUsage();

  let totalTokens = calculatedTotal;
  if (
    fields.total !== undefined &&
    Object.prototype.hasOwnProperty.call(usage, fields.total)
  ) {
    totalTokens = tokenCount(usage[fields.total]);
    if (totalTokens !== calculatedTotal) return invalidUsage();
  }
  return { inputTokens, outputTokens, totalTokens };
}
