import type { FileContract, SkillContract, SkillId } from "@9thlevelsoftware/legion-cli-schema";

/** Engine-constant SkillContract roots. Globs are allowed here only. */
export const SKILL_CONTRACTS: Record<SkillId, readonly string[]> = {
  interview: [".legion-cli/wiki/product/**", ".legion-cli/specs/*/prd.md", ".legion-cli/cache/runs/<id>/**"],
  discuss: [".legion-cli/discuss/**", ".legion-cli/decisions/**", ".legion-cli/cache/runs/<id>/**"],
  spec: [".legion-cli/specs/<activeSpecId>/**", ".legion-cli/cache/runs/<id>/**"],
  // No audit/**: the audit log is protected so an agent can't forge it (KD-1, F-046).
  ingest: [".legion-cli/wiki/**", ".legion-cli/cache/runs/<id>/**"],
  plan: [".legion-cli/plans/**", ".legion-cli/tasks/**", ".legion-cli/cache/runs/<id>/**"],
  execute: [".legion-cli/cache/runs/<id>/**"],
  // F-025, F-047, R-2: verify/review write only their notes. They may still file NEW fix tasks
  // (`.legion-cli/tasks/TSK-*.md`, validated and admitted at finish); existing task files, QA
  // scores and the checklist stay byte-protected.
  verify: [".legion-cli/qa/verify.md", ".legion-cli/qa/verify/*.md", ".legion-cli/cache/runs/<id>/**"],
  review: [".legion-cli/qa/review.md", ".legion-cli/cache/runs/<id>/**"],
  qa: [".legion-cli/cache/runs/<id>/**"],
  map: [".legion-cli/map/ARCHITECTURE.md", ".legion-cli/cache/runs/<id>/**"],
  wireframe: [".legion-cli/specs/<activeSpecId>/wireframes/**", ".legion-cli/cache/runs/<id>/**"],
  chat: [".legion-cli/cache/runs/<id>/**"],
};

/** Revert implicit denylist (KD-11 gate 3). Not the plan-time SoT list. */
const IMPLICIT_FORBIDDEN = [
  ".git/**",
  ".env*",
  ".legion-cli/config.yaml",
  ".legion-cli/index/**",
];

/**
 * Engine runtime areas outside the protected set and the revert walk: cache, index, worktrees,
 * sandbox jails and serve.json. Not an agent write root: an agent may write only its own run's
 * cache (`cache/runs/<id>/**`, in every SkillContract). `audit/**` is NOT here: it is protected
 * (KD-1), so an agent can't forge audit lines (F-046).
 */
const ENGINE_OWNED = [
  ".legion-cli/cache/**",
  ".legion-cli/index/**",
  ".legion-cli/worktrees/**",
  ".legion-cli/sandbox/**",
  ".legion-cli/serve.json",
];

/** New fix-task files plan/review/verify may create (validated and admitted at finish, R-2). */
export const NEW_TASK_FILE_PATTERN = ".legion-cli/tasks/TSK-*.md";

export function skillContract(skillId: SkillId, opts: { runId: string; specId?: string }): SkillContract {
  const roots = SKILL_CONTRACTS[skillId].map((root) =>
    root.replaceAll("<id>", opts.runId).replaceAll("<activeSpecId>", opts.specId ?? "*"),
  );
  return { skillId, allowedRoots: roots };
}

/**
 * Execute allowed = SkillContract cache root ∪ FileContract.filesAllowed ∪ expectedArtifacts.
 * KD-11 gate 2: `.legion-cli/**` except `cache/runs/<id>/**` is extra (SoT is not an execute write root).
 */
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

/** `.env` / `.env.*` in any path segment, any case (NTFS would otherwise alias `.ENV` onto `.env`). */
export function isEnvBasename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.");
}

/** True when any segment is `.git`, in any case (NTFS/APFS alias `.GIT` onto `.git`). */
export function hasGitSegment(posixPath: string): boolean {
  return posixPath.split("/").some((part) => part.toLowerCase() === ".git");
}

export function isImplicitForbidden(posixPath: string): boolean {
  // Case-insensitive (F-060, F-087): `.LEGION-CLI/config.yaml` is the same file on win32/darwin.
  const lower = posixPath.toLowerCase();
  if (hasGitSegment(posixPath)) return true;
  if (lower === ".legion-cli/config.yaml") return true;
  if (lower.startsWith(".legion-cli/index/") || lower === ".legion-cli/index") return true;
  if (posixPath.split("/").some((part) => isEnvBasename(part))) return true;
  return IMPLICIT_FORBIDDEN.some((pattern) => matchesGlob(pattern, lower));
}

export function isEngineOwned(posixPath: string): boolean {
  const lower = posixPath.toLowerCase();
  return ENGINE_OWNED.some((pattern) => matchesGlob(pattern, lower));
}

export function isAllowedPath(posixPath: string, allowedRoots: readonly string[]): boolean {
  if (isImplicitForbidden(posixPath)) return false;
  // `.legion-cli` paths match only in their canonical spelling (a contract root is lowercase).
  const lower = posixPath.toLowerCase();
  if ((lower === ".legion-cli" || lower.startsWith(".legion-cli/")) && !posixPath.startsWith(".legion-cli")) {
    return false;
  }
  return allowedRoots.some((root) => matchesGlob(root, posixPath));
}

/** plan, review and verify may create new task files (R-2). */
export function admitsNewTasks(skillId: SkillId): boolean {
  return skillId === "plan" || skillId === "review" || skillId === "verify";
}
