import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { ProviderError } from "./provider.js";

interface CodexPlatformPackage {
  readonly name: string;
  readonly target: string;
  readonly binary: string;
}

const CODEX_PLATFORM_PACKAGES: Readonly<Record<string, CodexPlatformPackage>> =
  Object.freeze({
    "darwin-arm64": {
      name: "@openai/codex-darwin-arm64",
      target: "aarch64-apple-darwin",
      binary: "codex",
    },
    "darwin-x64": {
      name: "@openai/codex-darwin-x64",
      target: "x86_64-apple-darwin",
      binary: "codex",
    },
    "linux-arm64": {
      name: "@openai/codex-linux-arm64",
      target: "aarch64-unknown-linux-musl",
      binary: "codex",
    },
    "linux-x64": {
      name: "@openai/codex-linux-x64",
      target: "x86_64-unknown-linux-musl",
      binary: "codex",
    },
    "win32-arm64": {
      name: "@openai/codex-win32-arm64",
      target: "aarch64-pc-windows-msvc",
      binary: "codex.exe",
    },
    "win32-x64": {
      name: "@openai/codex-win32-x64",
      target: "x86_64-pc-windows-msvc",
      binary: "codex.exe",
    },
  });

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

async function assertPackage(
  packageJsonPath: string,
  expectedRoot: string,
  expectedName: string,
): Promise<string> {
  const packageJson = await realpath(packageJsonPath);
  const packageRoot = await realpath(dirname(packageJson));
  if (!isWithin(expectedRoot, packageJson) || packageRoot !== expectedRoot) {
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Provider package resolved outside its expected root",
    );
  }
  const bytes = await readFile(packageJson);
  if (bytes.length > 64 * 1024) {
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Provider package metadata exceeds its hard limit",
    );
  }
  let name: unknown;
  try {
    name = (JSON.parse(bytes.toString("utf8")) as { readonly name?: unknown })
      .name;
  } catch {
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Provider package metadata is invalid",
    );
  }
  if (name !== expectedName) {
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Provider package identity is invalid",
    );
  }
  return packageRoot;
}

export async function resolveCodexNativeExecutable(
  wrapperPath: string,
): Promise<string | undefined> {
  const packageRoot = dirname(dirname(wrapperPath));
  if (
    wrapperPath !== join(packageRoot, "bin", "codex.js") ||
    packageRoot.split(/[\\/]/u).slice(-2).join("/") !== "@openai/codex"
  ) {
    return undefined;
  }
  const platform =
    CODEX_PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (platform === undefined) {
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Codex does not provide a native package for this platform",
    );
  }
  try {
    const require = createRequire(wrapperPath);
    const wrapperPackage = require.resolve("@openai/codex/package.json");
    await assertPackage(wrapperPackage, packageRoot, "@openai/codex");
    const nativePackageJson = require.resolve(`${platform.name}/package.json`);
    const nativeRoot = await realpath(dirname(nativePackageJson));
    await assertPackage(nativePackageJson, nativeRoot, platform.name);
    const expected = join(
      nativeRoot,
      "vendor",
      platform.target,
      "codex",
      platform.binary,
    );
    const nativeExecutable = await realpath(expected);
    if (
      !isWithin(nativeRoot, nativeExecutable) ||
      nativeExecutable !== expected
    ) {
      throw new ProviderError(
        "PROVIDER_UNSAFE",
        "Codex native executable resolved outside its package",
      );
    }
    return nativeExecutable;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Codex native executable could not be resolved safely",
    );
  }
}
