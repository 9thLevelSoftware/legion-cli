import type { FileContract, SkillContract, SkillId } from "@9thlevelsoftware/legion-cli-schema";

/** Engine-constant SkillContract roots. Globs are allowed here only. */
export const SKILL_CONTRACTS: Record<SkillId, readonly string[]> = {
  interview: [".legion-cli/wiki/product/**", ".legion-cli/specs/*/prd.md", ".legion-cli/cache/runs/<id>/**"],
  discuss: [".legion-cli/discuss/**", ".legion-cli/decisions/**", ".legion-cli/cache/runs/<id>/**"],
  spec: [".legion-cli/specs/<activeSpecId>/**", ".legion-cli/cache/runs/<id>/**"],
  ingest: [".legion-cli/wiki/**", ".legion-cli/audit/**", ".legion-cli/cache/runs/<id>/**"],
  plan: [".legion-cli/plans/**", ".legion-cli/tasks/**", ".legion-cli/cache/runs/<id>/**"],
  execute: [".legion-cli/cache/runs/<id>/**"],
  verify: [".legion-cli/qa/**", ".legion-cli/tasks/**", ".legion-cli/cache/runs/<id>/**"],
  review: [".legion-cli/qa/**", ".legion-cli/tasks/**", ".legion-cli/cache/runs/<id>/**"],
  qa: [".legion-cli/qa/**", ".legion-cli/cache/runs/<id>/**"],
};

const IMPLICIT_FORBIDDEN = [
  ".git/**",
  ".env*",
  ".legion-cli/config.yaml",
  ".legion-cli/index/**",
];

/** Cache/index/worktrees are engine-owned and gitignored; never revert them as extras. */
const ENGINE_OWNED = [".legion-cli/cache/**", ".legion-cli/index/**", ".legion-cli/worktrees/**"];

export function skillContract(skillId: SkillId, opts: { runId: string; specId?: string }): SkillContract {
  const roots = SKILL_CONTRACTS[skillId].map((root) =>
    root.replaceAll("<id>", opts.runId).replaceAll("<activeSpecId>", opts.specId ?? "*"),
  );
  return { skillId, allowedRoots: roots };
}

/** Execute allowed = SkillContract cache root ∪ FileContract.filesAllowed ∪ expectedArtifacts. */
export function executeAllowedRoots(runId: string, contract: FileContract): string[] {
  const skill = skillContract("execute", { runId });
  return [...skill.allowedRoots, ...contract.filesAllowed, ...contract.expectedArtifacts];
}

export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      const afterSlash = pattern[i + 2] === "/";
      out += afterSlash ? ".*" : ".*";
      i += afterSlash ? 2 : 1;
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if ("\\^$+()[]{}|.".includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(`^${out}$`);
}

export function matchesGlob(pattern: string, posixPath: string): boolean {
  return globToRegExp(pattern).test(posixPath);
}

export function isImplicitForbidden(posixPath: string): boolean {
  if (posixPath === ".git" || posixPath.startsWith(".git/")) return true;
  if (posixPath === ".legion-cli/config.yaml") return true;
  if (posixPath.startsWith(".legion-cli/index/") || posixPath === ".legion-cli/index") return true;
  const base = posixPath.split("/").pop() ?? posixPath;
  if (base === ".env" || base.startsWith(".env.")) return true;
  return IMPLICIT_FORBIDDEN.some((pattern) => matchesGlob(pattern, posixPath));
}

export function isEngineOwned(posixPath: string): boolean {
  return ENGINE_OWNED.some((pattern) => matchesGlob(pattern, posixPath));
}

export function isAllowedPath(posixPath: string, allowedRoots: readonly string[]): boolean {
  if (isImplicitForbidden(posixPath)) return false;
  if (isEngineOwned(posixPath)) return true;
  return allowedRoots.some((root) => matchesGlob(root, posixPath));
}
