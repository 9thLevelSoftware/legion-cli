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

/** Join a store POSIX path onto the project root using OS separators. */
export function toFsPath(projectRoot: string, storePath: string): string {
  const posix = toStorePath(storePath);
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    throw new PathEscapeError(storePath);
  }
  const parts = posix.split("/").filter((part) => part !== "");
  if (parts.some((part) => part === "." || part === "..")) {
    throw new PathEscapeError(storePath);
  }
  return resolve(projectRoot, ...parts);
}

export function resolveProjectPath(projectRoot: string, input: string): string {
  const posix = toStorePath(input);
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) {
    return resolve(toPosixPath(input));
  }
  const parts = posix.split("/").filter((part) => part !== "" && part !== ".");
  return resolve(projectRoot, ...parts);
}

/** Follow junctions/symlinks when the path exists so ingest containment is canonical. */
export function canonicalizePath(absPath: string): string {
  try {
    return realpathSync(absPath);
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
