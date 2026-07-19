const DEFAULT_MAX_FIELD_BYTES = 2_048;

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value) <= maximumBytes) {
    return value;
  }
  const suffix = "...";
  const contentLimit = maximumBytes - Buffer.byteLength(suffix);
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > contentLimit) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return `${result}${suffix}`;
}

export function escapeTerminalField(
  value: string,
  maximumBytes = DEFAULT_MAX_FIELD_BYTES,
): string {
  const jsonString = JSON.stringify(value);
  const escaped = jsonString
    .slice(1, -1)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined
        ? ""
        : `\\u${codePoint.toString(16).padStart(4, "0")}`;
    });
  return truncateUtf8(escaped, maximumBytes);
}
