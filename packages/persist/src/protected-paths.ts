import type { BigIntStats } from "node:fs";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isConcretePosixRepoRelativePath, normalizePathKey } from "@9thlevelsoftware/legion-cli-schema";
import { PathEscapeError } from "./errors.js";

/** Agent-inaccessible authority roots; engine persistence and operator inspection do not use this gate. */
export const ENGINE_PROTECTED_PATHS = [
  ".legion-cli/workflow",
  ".legion-cli/audit/governance",
  ".legion-cli/audit/http-governed",
  ".legion-cli/audit/delivery",
  ".legion-cli/audit/delivery-export",
  ".legion-cli/audit/raw-logs",
] as const;

function pathKey(path: string): string {
  const parts = normalizePathKey(path.replaceAll("\\", "/")).split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  if (/^legion~\d+$/.test(normalized[0] ?? "")) normalized[0] = ".legion-cli";
  return normalized.join("/");
}

function contains(root: string, path: string): boolean {
  return root === path || path.startsWith(`${root}/`);
}

function overlaps(left: string, right: string): boolean {
  return !left || !right || contains(left, right) || contains(right, left);
}

function shortControlAlias(key: string): boolean {
  const parts = key.split("/");
  return parts[0] === ".legion-cli" && parts.slice(1).some((part) => /^[^~.]{1,6}~\d+(\.[^.]{1,3})?$/.test(part));
}

/** Deny-side normalization is deliberately conservative on every host filesystem. */
export function isEngineProtectedPath(path: string): boolean {
  const key = pathKey(path);
  return shortControlAlias(key) || ENGINE_PROTECTED_PATHS.some((root) => contains(root, key));
}

/** A directory grant also exposes its descendants. Wildcard grants are bounded by their literal prefix. */
export function overlapsEngineProtectedPath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  const wildcard = parts.findIndex((part) => /[*?\[]/.test(part));
  const key = pathKey((wildcard < 0 ? parts : parts.slice(0, wildcard)).join("/"));
  return shortControlAlias(key) || ENGINE_PROTECTED_PATHS.some((root) => overlaps(root, key));
}

async function resolvedWithMissingTail(path: string): Promise<string> {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(current), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      tail.unshift(relative(parent, current));
      current = parent;
    }
  }
}

const MAX_CONTROL_IDENTITY_ENTRIES = 100_000;
const MAX_CONTROL_IDENTITY_DEPTH = 64;

function controlIdentityError(path: string, reason: string): PathEscapeError {
  const error = new PathEscapeError(path);
  error.message = `agent path admission denied for ${path}: ${reason}`;
  return error;
}

async function assertNoControlFileIdentityAlias(root: string, target: string, path: string): Promise<void> {
  const candidate = await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!candidate?.isFile() || candidate.nlink <= 1n) return;
  if (candidate.ino === 0n) throw controlIdentityError(path, "filesystem file identity is unavailable");
  const identity = (value: BigIntStats): string => `${value.dev}:${value.ino}`;
  const candidateIdentity = identity(candidate);
  const visited = new Set<string>();
  let entries = 0;

  const inspect = async (entry: string, depth: number): Promise<void> => {
    if (++entries > MAX_CONTROL_IDENTITY_ENTRIES || depth > MAX_CONTROL_IDENTITY_DEPTH) {
      throw controlIdentityError(path, "protected authority inventory exceeds the bounded inspection limit");
    }
    const before = await lstat(entry, { bigint: true });
    if (before.isSymbolicLink()) {
      const linked = await stat(entry, { bigint: true });
      // Never recursively follow nested control-tree links, including junctions and cycles.
      if (!linked.isFile()) throw controlIdentityError(path, "nested protected links cannot be safely inspected as regular files");
      if (linked.ino === 0n) throw controlIdentityError(path, "protected file identity is unavailable");
      if (identity(linked) === candidateIdentity) throw controlIdentityError(path, "file identity aliases engine-owned authority");
      return;
    }
    if (before.isFile()) {
      if (before.ino === 0n) throw controlIdentityError(path, "protected file identity is unavailable");
      if (identity(before) === candidateIdentity) throw controlIdentityError(path, "file identity aliases engine-owned authority");
      return;
    }
    if (!before.isDirectory()) return;
    if (before.ino === 0n) throw controlIdentityError(path, "protected directory identity is unavailable");
    const directoryIdentity = identity(before);
    if (visited.has(directoryIdentity)) return;
    visited.add(directoryIdentity);
    const directory = await opendir(entry);
    for await (const child of directory) {
      await inspect(join(entry, child.name), depth + 1);
    }
    const after = await lstat(entry, { bigint: true });
    if (!after.isDirectory() || identity(after) !== directoryIdentity ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw controlIdentityError(path, "protected authority inventory changed during inspection");
    }
  };

  try {
    for (const protectedPath of ENGINE_PROTECTED_PATHS) {
      const control = join(root, ...protectedPath.split("/"));
      const resolvedControl = await realpath(control).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (resolvedControl === null) continue;
      await inspect(resolvedControl, 0);
      if (await realpath(control) !== resolvedControl) {
        throw controlIdentityError(path, "protected authority root changed during inspection");
      }
    }
    const after = await lstat(target, { bigint: true });
    if (!after.isFile() || identity(after) !== candidateIdentity || after.nlink !== candidate.nlink) {
      throw controlIdentityError(path, "candidate file identity changed during inspection");
    }
  } catch (error) {
    if (error instanceof PathEscapeError) throw error;
    throw controlIdentityError(path, "protected authority inventory could not be completely inspected");
  }
}

async function agentControlTarget(projectRoot: string, path: string): Promise<{ root: string; target: string }> {
  if (!isConcretePosixRepoRelativePath(path) || overlapsEngineProtectedPath(path)) {
    throw new PathEscapeError(path);
  }
  const root = await realpath(resolve(projectRoot));
  const target = await resolvedWithMissingTail(join(root, ...path.split("/")));
  const rel = relative(root, target).replaceAll("\\", "/");
  if (rel && rel !== ".." && !rel.startsWith("../") && !/^[A-Za-z]:/.test(rel) && !rel.startsWith("/") &&
      overlapsEngineProtectedPath(rel)) {
    throw new PathEscapeError(path);
  }
  const targetKey = pathKey(target);
  for (const protectedPath of ENGINE_PROTECTED_PATHS) {
    const protectedTarget = await resolvedWithMissingTail(join(root, ...protectedPath.split("/")));
    if (overlaps(targetKey, pathKey(protectedTarget))) throw new PathEscapeError(path);
  }
  await assertNoControlFileIdentityAlias(root, target, path);
  return { root, target };
}

/** Control-only admission; sandbox staging separately omits outside-project and Git aliases. */
export async function assertAgentControlPathAllowed(projectRoot: string, path: string): Promise<void> {
  await agentControlTarget(projectRoot, path);
}

/** Admission for concrete agent read/write grants, including junction aliases and not-yet-created targets. */
export async function assertAgentPathAllowed(projectRoot: string, path: string): Promise<void> {
  const { root, target } = await agentControlTarget(projectRoot, path);
  const rel = relative(root, target).replaceAll("\\", "/");
  if (!rel || rel === ".." || rel.startsWith("../") || /^[A-Za-z]:/.test(rel) || rel.startsWith("/")) {
    throw new PathEscapeError(path);
  }
}
