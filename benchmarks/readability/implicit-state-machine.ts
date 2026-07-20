export function advanceExport(state: string): string {
  if (state === "created") return "collecting";
  if (state === "collecting") return "transforming";
  if (state === "transforming") return "writing";
  if (state === "writing") return "completed";
  if (state === "failed") return "cleanup";
  return "failed";
}
