import { redactSecrets } from "../providers/provider.js";
import type { ReviewDiagnostic } from "../review/stage-output.js";

export const MAX_STORED_DIAGNOSTICS = 32;
export const MAX_STORED_DIAGNOSTIC_CODE_BYTES = 120;
export const MAX_STORED_DIAGNOSTIC_STAGE_BYTES = 120;
export const MAX_STORED_DIAGNOSTIC_PATH_BYTES = 256;
export const MAX_STORED_DIAGNOSTIC_MESSAGE_BYTES = 512;

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const suffix = "...";
  const contentLimit = maximumBytes - Buffer.byteLength(suffix, "utf8");
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > contentLimit) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${suffix}`;
}

function boundedRedacted(value: string, maximumBytes: number): string {
  return truncateUtf8(redactSecrets(value, []), maximumBytes);
}

export function projectRunDiagnostics(
  diagnostics: readonly ReviewDiagnostic[] | undefined,
): readonly ReviewDiagnostic[] {
  return Object.freeze(
    (diagnostics ?? []).slice(0, MAX_STORED_DIAGNOSTICS).map((diagnostic) =>
      Object.freeze({
        code: diagnostic.code,
        stageId: boundedRedacted(
          diagnostic.stageId,
          MAX_STORED_DIAGNOSTIC_STAGE_BYTES,
        ),
        ...(diagnostic.path === undefined
          ? {}
          : {
              path: boundedRedacted(
                diagnostic.path,
                MAX_STORED_DIAGNOSTIC_PATH_BYTES,
              ),
            }),
        message: boundedRedacted(
          diagnostic.message,
          MAX_STORED_DIAGNOSTIC_MESSAGE_BYTES,
        ),
      }),
    ),
  );
}
