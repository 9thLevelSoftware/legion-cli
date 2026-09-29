import { z } from "zod";

const GLOB_OR_BACKSLASH = /[*?[\\]/;

/**
 * Concrete POSIX repo-relative path: no globs, no `.git` segment, no `.` / `..`,
 * no absolute or drive-letter paths. Used by Zod and emitted JSON Schema.
 */
export const CONCRETE_POSIX_PATH_REGEX =
  /^(?![A-Za-z]:)(?!\/)(?:(?!\.git(?:\/|$))(?!\.(?:\/|$))(?!\.\.(?:\/|$))[^\\*?[\]/]+)(?:\/(?!\.git(?:\/|$))(?!\.(?:\/|$))(?!\.\.(?:\/|$))[^\\*?[\]/]+)*$/;

/**
 * Windows 8.3 short-name segment (`GIT~1`, `PROGRA~1`). Deliberately narrow: no extension, at most
 * six leading characters, so `notes~2.md` stays a legal name.
 */
const SHORT_NAME_SEGMENT = /^[^~.]{1,6}~\d+$/;

export function isShortNameSegment(segment: string): boolean {
  return SHORT_NAME_SEGMENT.test(segment);
}

/**
 * One segment in the form every trust-boundary comparison uses: lowercase, an NTFS alternate data
 * stream (`:...`) cut off, and trailing dots and spaces stripped (Windows ignores them).
 */
export function normalizePathSegment(segment: string): string {
  const colon = segment.indexOf(":");
  const base = colon === -1 ? segment : segment.slice(0, colon);
  return base.toLowerCase().replace(/[. ]+$/, "");
}

/** A POSIX path with every segment normalised; compare these, never the raw strings. */
export function normalizePathKey(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment === "." || segment === ".." ? segment : normalizePathSegment(segment)))
    .join("/");
}

/**
 * v0 FileContract.filesAllowed: concrete POSIX repo-relative paths only.
 * Rejects `*`, `**`, `?`, backslashes, absolute paths, and any `.git` segment.
 */
export function isConcretePosixRepoRelativePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (GLOB_OR_BACKSLASH.test(path)) return false;
  if (path.includes(":")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment === ".git")) {
    return false;
  }
  // Judge each segment in its normalised form: NTFS ignores trailing dots/spaces, so `GIT~1.` is
  // `GIT~1`, and `.. ` or `...` collapse to an empty or dot-only name.
  if (
    segments.some((segment) => {
      const norm = normalizePathSegment(segment);
      return norm === "" || norm === "." || norm === ".." || norm === ".git" || isShortNameSegment(norm);
    })
  ) {
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
