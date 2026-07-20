import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CiTarget = "github" | "gitlab";

const TEMPLATE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "templates",
  "ci",
);

function destinationFor(
  repository: string,
  target: CiTarget,
): { readonly path: string; readonly template: string } {
  if (target === "github") {
    return {
      path: join(repository, ".github", "workflows", "code-quality.yml"),
      template: join(TEMPLATE_ROOT, "github-actions.yml"),
    };
  }
  return {
    path: join(repository, ".gitlab-ci.code-quality.yml"),
    template: join(TEMPLATE_ROOT, "gitlab-ci.yml"),
  };
}

export async function planCiInstall(options: {
  readonly repository: string;
  readonly target: CiTarget;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const dest = destinationFor(options.repository, options.target);
  let exists = false;
  try {
    await access(dest.path);
    exists = true;
  } catch {
    exists = false;
  }
  return {
    exitCode: 0,
    output: [
      "CI install plan:",
      `target: ${options.target}`,
      `template: ${dest.template}`,
      `destination: ${dest.path}`,
      `exists: ${exists ? "yes (will refuse without --force)" : "no"}`,
      "notes:",
      "- Templates are deterministic check-only (no production credentials).",
      "- Enabling required branch protection is an ops step outside this CLI.",
      "- This repository's own CI remains inactive until ops copies/enables it.",
      "Re-run with --confirm to write the destination file.",
      "",
    ].join("\n"),
  };
}

export async function installCi(options: {
  readonly repository: string;
  readonly target: CiTarget;
  readonly confirm?: boolean;
  readonly force?: boolean;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  if (options.confirm !== true) {
    return planCiInstall(options);
  }
  const dest = destinationFor(options.repository, options.target);
  try {
    await access(dest.path);
    if (options.force !== true) {
      return {
        exitCode: 2,
        output: `Refusing to overwrite existing ${dest.path}. Pass --force to replace.\n`,
      };
    }
  } catch {
    // missing is fine
  }
  const body = await readFile(dest.template, "utf8");
  // Strip the inactive banner comment for installed copies and add ops note.
  const installed = body
    .replace(
      /^# Inactive template\.[^\n]*\n/u,
      "# Installed by code-quality ci install. Review least-privilege and branch protection before enabling as a required check.\n",
    )
    .replace(
      /^# Inactive template\.[^\n]*\n/u,
      "# Installed by code-quality ci install.\n",
    );
  await mkdir(dirname(dest.path), { recursive: true });
  const temporary = `${dest.path}.tmp`;
  await writeFile(temporary, installed, { mode: 0o644, flag: "w" });
  await rename(temporary, dest.path);
  return {
    exitCode: 0,
    output: [
      `Installed CI template to ${dest.path}`,
      "Next ops steps:",
      "1. Verify pinned action revisions or the locked GitLab runner image.",
      "2. Ensure runners have no production credentials.",
      "3. Enable branch protection required check only after review.",
      "",
    ].join("\n"),
  };
}

export async function ciStatus(options: {
  readonly repository: string;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const github = join(
    options.repository,
    ".github",
    "workflows",
    "code-quality.yml",
  );
  const gitlab = join(options.repository, ".gitlab-ci.code-quality.yml");
  const lines: string[] = ["CI activation status:"];
  for (const [label, path] of [
    ["github", github],
    ["gitlab", gitlab],
  ] as const) {
    try {
      await access(path);
      lines.push(`${label}: present at ${path}`);
    } catch {
      lines.push(
        `${label}: not installed (templates remain under templates/ci/)`,
      );
    }
  }
  lines.push(
    "package-repo default: workflows are not auto-enabled (design reservation).",
  );
  lines.push("");
  return { exitCode: 0, output: `${lines.join("\n")}\n` };
}
