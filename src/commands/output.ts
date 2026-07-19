export type CommandOutputFormat = "json" | "terminal";

export interface RenderedCommandResult<T> {
  readonly exitCode: number;
  readonly output: string;
  readonly report: T;
}
