import { existsSync } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { PathEscapeError, toPosixPath, toProjectRelativePosix } from "@9thlevelsoftware/legion-cli-persist";
import { ConcretePosixPathSchema } from "@9thlevelsoftware/legion-cli-schema";
import { MAP_HINT, refuse } from "./errors.js";
import { languageFromPath, MAX_FILE_BYTES, type SourceLanguage } from "./parse.js";

export const MAX_MODULES = 10_000;

export const DEFAULT_MAP_ROOTS = ["src", "packages", "app", "lib"] as const;

export const DEFAULT_IGNORE = ["**/*.test.*", "**/*.spec.*", "**/dist/**"] as const;

/** Brownfield SKIP_DIR_NAMES plus entire `.legion-cli/`. */
export const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".legion-cli",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

const SKIP_DIR_LOWER = new Set([...SKIP_DIR_NAMES].map((name) => name.toLowerCase()));

export type WalkedFile = {
  path: string;
  absPath: string;
  language: Exclude<SourceLanguage, "other">;
  text: string;
};

/** Minimatch-lite for ignore globs (`**`, `*`, `?`). */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.replaceAll("\\", "/");
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
      continue;
    }
    const ch = pattern[i];
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += (ch ?? "").replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

function compileIgnore(globs: readonly string[]): RegExp[] {
  return globs.filter((glob) => glob.length > 0).map(globToRegExp);
}

function isIgnored(posixPath: string, rules: readonly RegExp[]): boolean {
  return rules.some((rule) => rule.test(posixPath));
}

function isSkippedDirName(name: string): boolean {
  if (SKIP_DIR_NAMES.has(name)) return true;
  if (process.platform === "win32") return SKIP_DIR_LOWER.has(name.toLowerCase());
  return false;
}

function hasSkipSegment(posixPath: string): boolean {
  return posixPath.split("/").some((segment) => isSkippedDirName(segment));
}

export function assertMapRoot(raw: string): string {
  const posix = toPosixPath(raw).replace(/^\.\//, "");
  const parsed = ConcretePosixPathSchema.safeParse(posix);
  if (!parsed.success) {
    refuse(`map root is not a concrete POSIX repo-relative path: ${raw}`, MAP_HINT.concretePaths);
  }
  return parsed.data;
}

export function resolveMapRoots(projectRoot: string, requested: readonly string[] | undefined): string[] | null {
  if (requested !== undefined) {
    if (requested.length === 0) return null;
    return requested.map(assertMapRoot);
  }
  const existing = DEFAULT_MAP_ROOTS.filter((root) => existsSync(join(projectRoot, root)));
  return existing.length > 0 ? [...existing] : null;
}

function looksBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  return !Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

async function posixInside(projectRoot: string, absPath: string): Promise<string | null> {
  try {
    const real = await realpath(absPath);
    return toProjectRelativePosix(projectRoot, real);
  } catch (err) {
    if (err instanceof PathEscapeError) return null;
    try {
      const rel = toPosixPath(relative(resolve(projectRoot), resolve(absPath)));
      if (rel === "" || rel === ".") return ".";
      if (rel.startsWith("../") || rel === ".." || /^[A-Za-z]:/.test(rel) || rel.startsWith("/")) return null;
      return rel;
    } catch {
      return null;
    }
  }
}

export async function walkSources(opts: {
  projectRoot: string;
  roots: readonly string[] | null;
  ignore: readonly string[];
}): Promise<WalkedFile[]> {
  const projectRoot = resolve(opts.projectRoot);
  const rules = compileIgnore(opts.ignore);
  const out: WalkedFile[] = [];
  const seenDirs = new Set<string>();
  const seenFiles = new Set<string>();
  const starts =
    opts.roots === null
      ? [projectRoot]
      : opts.roots.map((root) => join(projectRoot, ...root.split("/")));

  async function walkDir(dir: string): Promise<void> {
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      return;
    }
    const dirKey = process.platform === "win32" ? real.toLowerCase() : real;
    if (seenDirs.has(dirKey)) return;
    seenDirs.add(dirKey);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      if (isSkippedDirName(entry.name)) continue;
      const abs = join(dir, entry.name);
      let posix: string | null;
      try {
        posix = await posixInside(projectRoot, abs);
      } catch {
        continue;
      }
      if (!posix || posix === ".") continue;
      if (hasSkipSegment(posix)) continue;

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let targetSize: number | undefined;
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(abs);
          isDir = target.isDirectory();
          isFile = target.isFile();
          targetSize = target.size;
        } catch {
          continue;
        }
      }
      if (isDir) {
        await walkDir(abs);
        continue;
      }
      if (!isFile) continue;
      if (isIgnored(posix, rules)) continue;
      const language = languageFromPath(posix);
      if (language === "other") continue;
      let meta;
      try {
        meta = await lstat(abs);
      } catch {
        continue;
      }
      const size = targetSize ?? meta.size;
      if (size > MAX_FILE_BYTES) continue;
      let buf: Buffer;
      try {
        buf = await readFile(abs);
      } catch {
        continue;
      }
      if (buf.byteLength > MAX_FILE_BYTES || looksBinary(buf)) continue;
      if (seenFiles.has(posix)) continue;
      if (out.length >= MAX_MODULES) {
        refuse("map exceeds 10000 modules", MAP_HINT.noLsp);
      }
      seenFiles.add(posix);
      out.push({ path: posix, absPath: abs, language, text: buf.toString("utf8") });
    }
  }

  for (const start of starts) {
    let posix: string | null;
    try {
      posix = existsSync(start) ? await posixInside(projectRoot, start) : null;
    } catch {
      continue;
    }
    if (posix === null && start !== projectRoot) continue;
    if (posix && posix !== "." && hasSkipSegment(posix)) continue;
    if (!existsSync(start)) continue;
    await walkDir(start);
  }

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
