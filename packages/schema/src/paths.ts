import { z } from "zod";

const GLOB_OR_BACKSLASH = /[*?[\\]/;

/**
 * v0 FileContract.filesAllowed: concrete POSIX repo-relative paths only.
 * Rejects `*`, `**`, `?`, backslashes, absolute paths, and `.git/` .
 */
export function isConcretePosixRepoRelativePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (GLOB_OR_BACKSLASH.test(path)) return false;
  if (path === ".git" || path.startsWith(".git/")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return true;
}

/** SkillContract.allowedRoots and filesForbidden may contain globs. */
export function isPosixRepoRelativeRoot(path: string): boolean {
  if (path.length === 0) return false;
  if (path.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) return false;
  if (segments.some((segment, i) => segment === "" && i !== segments.length - 1)) {
    return false;
  }
  return true;
}

export const ConcretePosixPathSchema = z
  .string()
  .min(1)
  .regex(/^[^\\*?[\]]+$/, "concrete POSIX repo-relative path (no globs)")
  .refine(isConcretePosixRepoRelativePath, {
    message:
      "filesAllowed entries must be concrete POSIX repo-relative paths (no *, **, ?, or .git/)",
  });

export const PosixAllowedRootSchema = z
  .string()
  .min(1)
  .regex(/^[^\\]+$/, "POSIX repo-relative path (globs permitted)")
  .refine(isPosixRepoRelativeRoot, {
    message: "allowedRoots must be POSIX repo-relative (globs permitted; no backslashes)",
  });
