import { builtinModules } from "node:module";
import type { FileHandle } from "node:fs/promises";
import { extname } from "node:path";

import ts from "typescript";

import { ProviderError } from "./provider.js";

const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
const builtins = new Set(
  builtinModules.flatMap((name) => [
    name,
    `node:${name.replace(/^node:/u, "")}`,
  ]),
);

function dependencySpecifier(node: ts.Node): string | undefined | null {
  if (
    ts.isImportDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isImportEqualsDeclaration(node)
  ) {
    const expression = ts.isImportEqualsDeclaration(node)
      ? ts.isExternalModuleReference(node.moduleReference)
        ? node.moduleReference.expression
        : undefined
      : node.moduleSpecifier;
    return expression === undefined
      ? undefined
      : ts.isStringLiteral(expression)
        ? expression.text
        : null;
  }
  if (!ts.isCallExpression(node)) return undefined;
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire =
    ts.isIdentifier(node.expression) && node.expression.text === "require";
  if (!isDynamicImport && !isRequire) return undefined;
  const argument = node.arguments[0];
  return argument !== undefined && ts.isStringLiteral(argument)
    ? argument.text
    : null;
}

function assertSelfContainedScript(source: string, path: string): void {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  if (hasUnsafeDependency(file)) {
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Provider script has dependencies that cannot be snapshotted safely",
    );
  }
}

function hasUnsafeDependency(node: ts.Node): boolean {
  const dependency = dependencySpecifier(node);
  if (
    dependency === null ||
    (dependency !== undefined && !builtins.has(dependency))
  ) {
    return true;
  }
  return (
    ts.forEachChild(node, (child) =>
      hasUnsafeDependency(child) ? true : undefined,
    ) === true
  );
}

export async function validateExecutableSource(
  handle: FileHandle,
  path: string,
  size: number,
): Promise<void> {
  const prefixLength = Math.min(size, 256);
  const prefix = Buffer.alloc(prefixLength);
  if (prefixLength > 0) await handle.read(prefix, 0, prefixLength, 0);
  const textPrefix = prefix.toString("utf8");
  const extension = extname(path).toLowerCase();
  const isJavaScript =
    extension === ".js" ||
    extension === ".mjs" ||
    extension === ".cjs" ||
    /^#![^\n]*\bnode\b/u.test(textPrefix);
  if (!isJavaScript) {
    if (textPrefix.startsWith("#!")) {
      throw new ProviderError(
        "PROVIDER_UNSAFE",
        "Provider interpreter scripts are not supported",
      );
    }
    return;
  }
  if (size > MAX_SCRIPT_BYTES) {
    throw new ProviderError(
      "PROVIDER_UNSAFE",
      "Provider script exceeds its dependency inspection limit",
    );
  }
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = await handle.read(bytes, offset, size - offset, offset);
    if (read.bytesRead === 0) {
      throw new ProviderError(
        "PROVIDER_UNSAFE",
        "Provider script changed while it was inspected",
      );
    }
    offset += read.bytesRead;
  }
  assertSelfContainedScript(bytes.toString("utf8"), path);
}
