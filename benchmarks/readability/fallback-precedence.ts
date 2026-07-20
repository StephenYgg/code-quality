interface ExportOptions {
  readonly explicit?: string;
  readonly profile?: string;
  readonly legacy?: string;
  readonly enabled: boolean;
  readonly mode: "archive" | "live";
}

// Mixed conditional and semantic fallback priorities are intentionally hidden.
export function selectDestination(options: ExportOptions): string {
  return options.enabled
    ? options.mode === "live"
      ? (options.explicit ?? options.profile ?? options.legacy ?? "default")
      : (options.profile ?? options.legacy ?? "archive")
    : (options.legacy ?? "disabled");
}
