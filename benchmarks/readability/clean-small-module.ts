export function chooseValue(
  value: string | undefined,
  fallback: string,
): string {
  return value ?? fallback;
}

export function displayMode(enabled: boolean): string {
  return enabled ? "visible" : "hidden";
}
