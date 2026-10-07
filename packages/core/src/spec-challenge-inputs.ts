import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isConcretePosixRepoRelativePath, normalizePathKey, type WorkflowPreparation } from "@9thlevelsoftware/legion-cli-schema";
import { isForbiddenSpawnPath } from "@9thlevelsoftware/legion-cli-wiki";

export const CHALLENGE_REPOSITORY_READ_ROOTS = [
  "package.json", "pnpm-lock.yaml", "package-lock.json", "tsconfig.json", "jsconfig.json",
  "src", "packages", "lib", "app", "test", "tests", "skills", "scripts", "docs", "README.md",
] as const;

/** New-policy inventory; unmarked challenges retain the fixed original roots above. */
export const PLANNING_REPOSITORY_READ_ROOTS = [
  ...CHALLENGE_REPOSITORY_READ_ROOTS,
  "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "poetry.lock",
  "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "pom.xml", "build.gradle", "build.gradle.kts",
  "settings.gradle", "settings.gradle.kts", "gradle.properties", "Gemfile", "Gemfile.lock",
  "composer.json", "composer.lock", "CMakeLists.txt", "Makefile", "Dockerfile", "compose.yaml",
  "docker-compose.yml", "wrangler.toml", "wrangler.jsonc", "infra", "infrastructure", "terraform",
] as const;

/** A conservative source-reading policy for the internal challenge only. */
export function challengeInputPathAllowed(path: string): boolean {
  const normalized = normalizePathKey(path);
  if (!isConcretePosixRepoRelativePath(path) || isForbiddenSpawnPath(normalized)) return false;
  return !normalized.split("/").some((name) =>
    ["node_modules", ".git", ".venv", "venv", "vendor", "target", ".ssh", ".aws", ".azure", ".gcloud", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "kubeconfig"].includes(name) ||
    /^\.env(?:\..*)?$/i.test(name) || /(?:^|\.)tfstate(?:\..*)?$/i.test(name) ||
    /^(?:credentials?|secrets?|tokens?|client[_-]?secrets?|service[_-]?accounts?)(?:[._-].*)?\.(?:json|ya?ml|toml|ini|txt|md|xml|conf|cfg|properties|env|log)$/i.test(name) ||
    /\.tfvars(?:\.json)?$/i.test(name) ||
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
      // A regular-looking hard link can alias a credential outside the declared roots.
      if (stat.nlink > 1) return;
      files.add(path);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const child of await readdir(join(projectRoot, ...path.split("/")))) await visit(`${path}/${child}`);
  };
  for (const root of roots) {
    if (!challengeInputPathAllowed(root)) continue;
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

/** Shared protected inventory for preparation, citations, challenge reads and freshness. */
export async function planningInputInventory(
  projectRoot: string,
  declaredRoots: readonly string[] = [],
  expanded = true,
): Promise<{ roots: string[]; files: string[]; limitations: string[] }> {
  const admittedDeclaredRoots = expanded ? declaredRoots : [];
  for (const root of admittedDeclaredRoots) {
    if (!challengeInputPathAllowed(root)) throw new Error(`declared planning input is unsafe or credential-bearing: ${root}`);
  }
  const roots = [...new Set([...(expanded ? PLANNING_REPOSITORY_READ_ROOTS : CHALLENGE_REPOSITORY_READ_ROOTS), ...admittedDeclaredRoots])].sort();
  const files = await challengeReadableFiles(projectRoot, roots);
  const limitations: string[] = [];
  for (const root of admittedDeclaredRoots) {
    if (!files.some((file) => file === root || file.startsWith(`${root}/`))) limitations.push(`Declared input ${root} has no readable regular files; it may be absent or excluded by link/credential policy.`);
  }
  if (expanded && !files.length) limitations.push("No readable project inputs were found; declare relevant source paths and verification commands before assuming repository facts.");
  return { roots, files, limitations };
}

/** Consume explicit captured document references; free-form prose never grants read authority. */
export function preparationInputRoots(record: WorkflowPreparation | null, gate: "spec" | "plan" = "spec"): string[] {
  if (!record) return [];
  return [...new Set([
    ...record.specArtifacts.flatMap((artifact) => artifact.inputs.map((input) => input.path)),
    ...(gate === "plan" ? record.planArtifacts.flatMap((artifact) => artifact.inputs.map((input) => input.path)) : []),
    ...(record.knowledge ?? []).map((input) => input.path),
  ])].sort();
}

export function planningContextRoots(specId?: string): string[] {
  if (specId && (specId.includes("/") || !isConcretePosixRepoRelativePath(specId))) throw new Error("invalid planning specification identity");
  return [".legion-cli/wiki/product", ".legion-cli/discuss", ".legion-cli/decisions", ".legion-cli/map",
    ...(specId ? [`.legion-cli/specs/${specId}`] : [])];
}
