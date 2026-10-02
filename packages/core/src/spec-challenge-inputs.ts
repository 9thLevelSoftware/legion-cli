import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isConcretePosixRepoRelativePath } from "@9thlevelsoftware/legion-cli-schema";
import { isForbiddenSpawnPath } from "@9thlevelsoftware/legion-cli-wiki";

export const CHALLENGE_REPOSITORY_READ_ROOTS = [
  "package.json", "pnpm-lock.yaml", "package-lock.json", "tsconfig.json", "jsconfig.json",
  "src", "packages", "lib", "app", "test", "tests", "skills", "scripts", "docs", "README.md",
] as const;

/** A conservative source-reading policy for the internal challenge only. */
export function challengeInputPathAllowed(path: string): boolean {
  if (!isConcretePosixRepoRelativePath(path) || isForbiddenSpawnPath(path)) return false;
  return !path.toLowerCase().split("/").some((name) =>
    ["node_modules", ".ssh", ".aws", ".azure", ".gcloud", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "kubeconfig"].includes(name) ||
    /^(?:credentials?|secrets?|tokens?|client[_-]?secrets?|service[_-]?accounts?)(?:[._-].*)?\.(?:json|ya?ml|toml|ini|txt)$/i.test(name) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|credentials)$/i.test(name),
  );
}

/** Enumerate regular readable files without following any ancestor or leaf link. */
export async function challengeReadableFiles(projectRoot: string, roots: readonly string[]): Promise<string[]> {
  const files = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    if (!challengeInputPathAllowed(path)) return;
    let stat;
    try {
      stat = await lstat(join(projectRoot, ...path.split("/")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      files.add(path);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const child of await readdir(join(projectRoot, ...path.split("/")))) await visit(`${path}/${child}`);
  };
  for (const root of roots) {
    let linked = false;
    const parts = root.split("/");
    for (let n = 1; n <= parts.length; n += 1) {
      try {
        if ((await lstat(join(projectRoot, ...parts.slice(0, n)))).isSymbolicLink()) {
          linked = true;
          break;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
        throw err;
      }
    }
    if (!linked) await visit(root);
  }
  return [...files].sort();
}
