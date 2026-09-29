import { isRestoreManifestPath } from "@9thlevelsoftware/legion-cli-persist";
import { normalizePathKey, type FileContract, type SkillContract, type SkillId } from "@9thlevelsoftware/legion-cli-schema";

export { isRestoreManifestPath };

/** Engine-constant SkillContract roots. Globs are allowed here only. */
export const SKILL_CONTRACTS: Record<SkillId, readonly string[]> = {
  interview: [".legion-cli/wiki/product/**", ".legion-cli/specs/*/prd.md", ".legion-cli/cache/runs/<id>/**"],
  discuss: [".legion-cli/discuss/**", ".legion-cli/decisions/**", ".legion-cli/cache/runs/<id>/**"],
  spec: [".legion-cli/specs/<activeSpecId>/**", ".legion-cli/cache/runs/<id>/**"],
  ingest: [".legion-cli/wiki/**", ".legion-cli/audit/**", ".legion-cli/cache/runs/<id>/**"],
  plan: [".legion-cli/plans/**", ".legion-cli/tasks/**", ".legion-cli/cache/runs/<id>/**"],
  execute: [".legion-cli/cache/runs/<id>/**"],
  verify: [".legion-cli/qa/verify.md", ".legion-cli/qa/verify/*.md", ".legion-cli/tasks/**", ".legion-cli/cache/runs/<id>/**"],
  // tasks/** is for filing new fix tasks; mutating existing TSK-*.md still FAILs review.
  review: [".legion-cli/qa/review.md", ".legion-cli/tasks/**", ".legion-cli/cache/runs/<id>/**"],
  qa: [".legion-cli/qa/**", ".legion-cli/cache/runs/<id>/**"],
  map: [".legion-cli/map/ARCHITECTURE.md", ".legion-cli/cache/runs/<id>/**"],
  wireframe: [".legion-cli/specs/<activeSpecId>/wireframes/**", ".legion-cli/cache/runs/<id>/**"],
  chat: [".legion-cli/cache/runs/<id>/**"],
};

/** Revert implicit denylist (KD-11 gate 3). Not the plan-time SoT list. */
const IMPLICIT_FORBIDDEN = [
  ".git/**",
  ".env*",
  ".legion-cli/config.yaml",
  ".legion-cli/STATE.md",
  ".legion-cli/tasks/**",
  ".legion-cli/index/**",
];

/** Cache/index/worktrees/audit/sandbox are engine-owned; never revert them as extras. chat/** is not — spawn-planted sessions must revert. */
const ENGINE_OWNED = [
  ".legion-cli/cache/**",
  ".legion-cli/index/**",
  ".legion-cli/worktrees/**",
  ".legion-cli/audit/**",
  ".legion-cli/sandbox/**",
];

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

/**
 * Allow-side key. Only as loose as the filesystem: Windows ignores case, trailing dots/spaces and
 * `:stream`; macOS is case-insensitive; Linux compares bytes. (The deny side below always
 * normalises fully, which is the safe direction on every platform.)
 */
function allowKey(path: string): string {
  if (process.platform === "win32") return normalizePathKey(path);
  if (process.platform === "darwin") return path.toLowerCase();
  return path;
}

function matchesRoot(root: string, posixPath: string): boolean {
  return matchesGlob(allowKey(root), allowKey(posixPath));
}

/**
 * `.env` / `.env.*` in any path segment, any case; trailing dots/spaces and `ENV~1` short names
 * (NTFS would otherwise alias them onto `.env`).
 */
export function isEnvBasename(name: string): boolean {
  const key = normalizePathKey(name);
  return key === ".env" || key.startsWith(".env.") || /^env~\d+(\.|$)/.test(key);
}

/**
 * Compared in normalised form (case, trailing dots/spaces, `:stream`, `GIT~1`/`LEGION~1` short
 * names), so `.GIT/x`, `.git./x` and `.LEGION-CLI/STATE.md` are refused like their plain forms.
 */
export function isImplicitForbidden(posixPath: string): boolean {
  const key = normalizePathKey(posixPath).replace(
    /^(?:legion~\d+)(?=\/|$)/,
    ".legion-cli",
  );
  const segments = key.split("/").map((part) => (/^git~\d+$/.test(part) ? ".git" : part));
  const canon = segments.join("/");
  if (segments.includes(".git")) return true;
  // 8.3 aliases of engine files directly under .legion-cli (`CONFIG~1.YAM`, `STATE~1.MD`).
  const under = canon.startsWith(".legion-cli/") ? canon.slice(".legion-cli/".length).split("/")[0] : undefined;
  if (under !== undefined && /^[^~.]{1,6}~\d+(\.[^.]{1,3})?$/.test(under)) return true;
  if (canon === ".legion-cli/config.yaml") return true;
  if (canon === ".legion-cli/state.md") return true;
  if (canon === ".legion-cli/tasks" || canon.startsWith(".legion-cli/tasks/")) return true;
  if (canon.startsWith(".legion-cli/index/") || canon === ".legion-cli/index") return true;
  if (segments.some((part) => isEnvBasename(part))) return true;
  return IMPLICIT_FORBIDDEN.some((pattern) => matchesGlob(pattern, canon));
}

export function isEngineOwned(posixPath: string): boolean {
  return ENGINE_OWNED.some((pattern) => matchesGlob(pattern, posixPath));
}

export function isAllowedPath(posixPath: string, allowedRoots: readonly string[]): boolean {
  if (isImplicitForbidden(posixPath)) return false;
  if (isEngineOwned(posixPath)) return true;
  return allowedRoots.some((root) => matchesRoot(root, posixPath));
}
