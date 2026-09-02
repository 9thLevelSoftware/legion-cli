import { z } from "zod";

const GLOB_OR_BACKSLASH = /[*?[\\]/;

/**
 * Concrete POSIX repo-relative path: no globs, no `.git` segment, no `.` / `..`,
 * no absolute or drive-letter paths. Used by Zod and emitted JSON Schema.
 */
export const CONCRETE_POSIX_PATH_REGEX =
  /^(?![A-Za-z]:)(?!\/)(?:(?!\.git(?:\/|$))(?!\.(?:\/|$))(?!\.\.(?:\/|$))[^\\*?[\]/]+)(?:\/(?!\.git(?:\/|$))(?!\.(?:\/|$))(?!\.\.(?:\/|$))[^\\*?[\]/]+)*$/;

/**
 * v0 FileContract.filesAllowed: concrete POSIX repo-relative paths only.
 * Rejects `*`, `**`, `?`, backslashes, absolute paths, and any `.git` segment.
 */
export function isConcretePosixRepoRelativePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (GLOB_OR_BACKSLASH.test(path)) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment === ".git")) {
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
  .regex(CONCRETE_POSIX_PATH_REGEX, "concrete POSIX repo-relative path (no globs, no .git/)")
  .refine(isConcretePosixRepoRelativePath, {
    message: "concrete POSIX repo-relative path (no globs, no .git/)",
  });

export const PosixAllowedRootSchema = z
  .string()
  .min(1)
  .regex(/^[^\\]+$/, "POSIX repo-relative path (globs permitted; no backslashes)")
  .refine(isPosixRepoRelativeRoot, {
    message: "POSIX repo-relative path (globs permitted; no backslashes)",
  });
