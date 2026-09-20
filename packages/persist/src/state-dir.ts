import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PersistError } from "./errors.js";
import { canonicalizePath } from "./paths.js";

/**
 * Per-user state, outside every project (KD-2, KD-9): `control/` (spawn liveness, resume records,
 * deferred audit) and `quarantine/` (displaced files, R-40). Never bound or copied into a jail.
 *
 * - Windows: `%LOCALAPPDATA%\legion-cli` (per-user ACL by default)
 * - macOS: `~/Library/Caches/legion-cli`
 * - Linux: `${XDG_STATE_HOME:-~/.local/state}/legion-cli`
 *
 * `LEGION_CLI_STATE_DIR` (absolute) overrides it; the test suites use it to stay out of the
 * real profile.
 */
export function userStateDir(): string {
  const override = process.env.LEGION_CLI_STATE_DIR;
  if (override && isAbsolute(override)) return resolve(override);
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return join(local && isAbsolute(local) ? local : join(homedir(), "AppData", "Local"), "legion-cli");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "legion-cli");
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"), "legion-cli");
}

/** Stable per-project key: sha256 of the canonical realpath (case-folded on win32/darwin), 16 hex. */
export function projectHash(projectRoot: string): string {
  let canonical = canonicalizePath(resolve(projectRoot));
  if (process.platform === "win32" || process.platform === "darwin") canonical = canonical.toLowerCase();
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function assertSafeSegment(value: string, what: string): string {
  if (!value || value !== value.trim() || /[\\/:]/.test(value) || value === "." || value.includes("..")) {
    throw new PersistError(`invalid ${what}: ${value}`);
  }
  return value;
}

export function controlProjectDirPath(projectRoot: string): string {
  return join(userStateDir(), "control", projectHash(projectRoot));
}

/** `<userStateDir>/control/<projectHash>/<runId>/` (path only; see {@link ensureControlDir}). */
export function controlDirPath(projectRoot: string, runId: string): string {
  return join(controlProjectDirPath(projectRoot), assertSafeSegment(runId, "runId"));
}

/** `<userStateDir>/quarantine/<projectHash>/` (path only). */
export function quarantineRootPath(projectRoot: string): string {
  return join(userStateDir(), "quarantine", projectHash(projectRoot));
}

/**
 * Create `abs` (under {@link userStateDir}) owner-only and check every level from the state dir
 * down: never a link or junction; on POSIX owned by this user with no group/other bits.
 */
export async function ensureOwnerDir(abs: string): Promise<string> {
  const base = userStateDir();
  const target = resolve(abs);
  const rel = relative(base, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PersistError(`refusing ${target}: not under the Legion state directory ${base}`);
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const levels = [base];
  let cursor = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    levels.push(cursor);
  }
  for (const level of levels) {
    const st = await lstat(level);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new PersistError(`refusing ${level}: the Legion state directory must be a real directory, not a link`);
    }
    if (process.platform !== "win32" && typeof process.getuid === "function") {
      if (st.uid !== process.getuid() || (st.mode & 0o077) !== 0) {
        throw new PersistError(`refusing ${level}: it must be owned by you with mode 0700 (chmod 700 ${level})`);
      }
    }
  }
  return target;
}

/**
 * The run's control dir. `exclusive` creates it with a plain `mkdir`, so two runs can never share
 * one set of control records (R-23); the heartbeat re-creates it non-exclusively.
 */
export async function ensureControlDir(
  projectRoot: string,
  runId: string,
  opts: { exclusive?: boolean } = {},
): Promise<string> {
  const target = controlDirPath(projectRoot, runId);
  if (opts.exclusive) {
    await ensureOwnerDir(dirname(target));
    await mkdir(target, { mode: 0o700 });
  }
  return ensureOwnerDir(target);
}

export async function ensureQuarantineRoot(projectRoot: string): Promise<string> {
  return ensureOwnerDir(quarantineRootPath(projectRoot));
}
