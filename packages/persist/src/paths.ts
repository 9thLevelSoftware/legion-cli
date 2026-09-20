import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { PathEscapeError } from "./errors.js";

/** Convert OS / ingest paths (including Windows `\`) to POSIX. */
export function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

/**
 * Repo-root-relative POSIX path for contracts, wiki links, and the index.
 * Ingest may pass `\`; the store always keeps `/`.
 */
export function toStorePath(input: string): string {
  let posix = toPosixPath(input).replace(/^\.\/+/, "");
  if (posix.endsWith("/") && posix.length > 1) {
    posix = posix.slice(0, -1);
  }
  return posix;
}

/**
 * Require resolve(root, candidate) stays under root.
 * Windows `relative()` of a different drive is `D:\…`, not `../`.
 */
export function assertResolvedInside(root: string, candidateAbs: string, label = candidateAbs): string {
  const rootAbs = resolve(root);
  const candAbs = resolve(candidateAbs);
  const rel = toPosixPath(relative(rootAbs, candAbs));
  if (rel === "" || rel === ".") return candAbs;
  if (rel.startsWith("../") || rel === ".." || /^[A-Za-z]:/.test(rel) || rel.startsWith("/")) {
    throw new PathEscapeError(label);
  }
  return candAbs;
}

/** Join a store POSIX path onto the project root using OS separators. */
export function toFsPath(projectRoot: string, storePath: string): string {
  const posix = toStorePath(storePath);
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    throw new PathEscapeError(storePath);
  }
  const parts = posix.split("/").filter((part) => part !== "");
  // `nested/D:file` is not absolute, but Windows resolve() treats `D:` as a drive.
  // POSIX names like `docs/api:v2.md` are valid; only reject drive-relative segments.
  if (parts.some((part) => part === "." || part === ".." || /^[A-Za-z]:/.test(part))) {
    throw new PathEscapeError(storePath);
  }
  return assertResolvedInside(projectRoot, resolve(projectRoot, ...parts), storePath);
}

export function resolveProjectPath(projectRoot: string, input: string): string {
  const posix = toStorePath(input);
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    return resolve(toPosixPath(input));
  }
  const parts = posix.split("/").filter((part) => part !== "" && part !== ".");
  return resolve(projectRoot, ...parts);
}

/**
 * Follow junctions/symlinks when the path exists so ingest containment is canonical.
 * Uses the native realpath (as `fs.promises.realpath`, which ingest uses, does) so
 * Windows 8.3 short names such as `RUNNER~1` expand to the long form on both sides;
 * the JS `realpathSync` keeps them, and `relative()` then escapes.
 */
export function canonicalizePath(absPath: string): string {
  try {
    return realpathSync.native(absPath);
  } catch {
    return resolve(absPath);
  }
}

export function toProjectRelativePosix(projectRoot: string, absolutePath: string): string {
  const root = canonicalizePath(projectRoot);
  const candidate = canonicalizePath(absolutePath);
  const rel = relative(root, candidate);
  const posix = toPosixPath(rel);
  if (posix === "" || posix === ".") {
    return ".";
  }
  if (posix.startsWith("../") || posix === "..") {
    throw new PathEscapeError(absolutePath);
  }
  if (/^[A-Za-z]:/.test(posix) || posix.startsWith("/")) {
    throw new PathEscapeError(absolutePath);
  }
  return posix;
}

export function assertInsideProject(projectRoot: string, candidateAbs: string): string {
  return toProjectRelativePosix(projectRoot, candidateAbs);
}
