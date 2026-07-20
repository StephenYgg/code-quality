import {
  isStoredRunRecord,
  type StoredRunRecord,
} from "./stored-run-record.js";

export function isSchemaValidRecord(
  value: unknown,
  key: string,
  expectedContentBundleHash?: string,
): value is StoredRunRecord {
  return isStoredRunRecord(value, {
    cacheKey: key,
    ...(expectedContentBundleHash === undefined
      ? {}
      : { expectedContentBundleHash }),
  });
}

export function isContentKey(key: string): boolean {
  return /^[a-f0-9]{64}$/u.test(key);
}
