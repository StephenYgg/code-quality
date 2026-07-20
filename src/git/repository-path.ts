import { isAbsolute, relative, sep } from "node:path";

export function isPathInsideRepository(
  repository: string,
  candidate: string,
): boolean {
  const relation = relative(repository, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) &&
      relation !== ".." &&
      !relation.startsWith(`..${sep}`))
  );
}
