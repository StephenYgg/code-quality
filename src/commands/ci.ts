import { ciStatus, installCi, type CiTarget } from "../ci/install.js";

export async function runCiInstallCommand(options: {
  readonly repository?: string;
  readonly target: string;
  readonly confirm?: boolean;
  readonly force?: boolean;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  if (options.target !== "github" && options.target !== "gitlab") {
    return {
      exitCode: 2,
      output: "CI target must be github or gitlab\n",
    };
  }
  const target: CiTarget = options.target;
  return installCi({
    repository: options.repository ?? ".",
    target,
    ...(options.confirm === true ? { confirm: true } : {}),
    ...(options.force === true ? { force: true } : {}),
  });
}

export async function runCiStatusCommand(options: {
  readonly repository?: string;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  return ciStatus({ repository: options.repository ?? "." });
}
