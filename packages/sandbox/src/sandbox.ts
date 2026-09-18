import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import {
  PathEscapeError,
  legionPaths,
  toFsPath,
  toPosixPath,
  toProjectRelativePosix,
} from "@9thlevelsoftware/legion-cli-persist";
import { isConcretePosixRepoRelativePath, type LegionConfig } from "@9thlevelsoftware/legion-cli-schema";
import { SandboxError } from "./errors.js";

export type SandboxBackend = "bwrap" | "seatbelt" | "copy";

export type SandboxPolicy = {
  projectRoot: string;
  runId: string;
  allowedWrites: readonly string[];
  readSet: readonly string[];
  adapterBinary?: string;
  env?: NodeJS.ProcessEnv;
  backend?: SandboxBackend | "auto";
};

export interface SandboxHandle {
  backend: SandboxBackend;
  hardened: boolean;
  jailRoot: string;
  spawnOpts(): { cwd: string; env: NodeJS.ProcessEnv; wrapper?: { bin: string; argvPrefix: string[] } };
  copyOut(): Promise<{ copied: string[]; dropped: string[] }>;
  destroy(): Promise<void>;
}

const HARDENED_REQUIRED =
  "hardened sandbox required (bwrap or seatbelt); copy jail refused without allowNoSandbox or sandbox.allowCopyJail";

const ADAPTER_CREDENTIAL_KEYS = [
  "CLAUDE_API_KEY",
  "GROK_API_KEY",
  "XAI_API_KEY",
  "OPENAI_API_KEY",
  "MINIMAX_API_KEY",
] as const;

const WINDOWS_INHERIT = ["ComSpec", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PATHEXT"] as const;

const SYSTEM_RO_BINDS = [
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/etc/resolv.conf",
  "/etc/ssl",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
] as const;

const WIN_STUB_EXT = /\.(cmd|bat|ps1)$/i;
const MAX_COPY_DEPTH = 32;

function tryRealpath(target: string): string | undefined {
  try {
    return realpathSync(target);
  } catch {
    return undefined;
  }
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function findOnPath(name: string, rejectStubs = false): string | undefined {
  const pathVal = process.env.PATH ?? process.env.Path ?? "";
  const pathExt = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM") : "";
  const exts = process.platform === "win32" ? pathExt.split(";").filter(Boolean) : [""];
  const hasExt =
    process.platform === "win32" && exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  const names = process.platform === "win32" && !hasExt ? [name, ...exts.map((ext) => `${name}${ext}`)] : [name];
  for (const dir of pathVal.split(delimiter)) {
    if (!dir) continue;
    for (const candidateName of names) {
      if (rejectStubs && WIN_STUB_EXT.test(candidateName)) continue;
      const candidate = join(dir, candidateName);
      if (existsSync(candidate)) {
        if (rejectStubs && WIN_STUB_EXT.test(candidate)) continue;
        return candidate;
      }
    }
  }
  return undefined;
}

function probeBwrapUserns(bin: string): boolean {
  // Ubuntu 24.04 / GitHub Actions AppArmor can leave bwrap on PATH while
  // --unshare-user fails with "setting up uid map: Permission denied".
  const args = [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--dev",
    "/dev",
  ];
  if (existsSync("/proc")) args.push("--proc", "/proc");
  for (const path of SYSTEM_RO_BINDS) {
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  const trueBin = existsSync("/usr/bin/true") ? "/usr/bin/true" : existsSync("/bin/true") ? "/bin/true" : "true";
  args.push("--", trueBin);
  const probe = spawnSync(bin, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 8000,
  });
  return !probe.error && probe.status === 0;
}

function findRunnableBwrap(): string | undefined {
  const bin = findOnPath("bwrap", true);
  if (!bin) return undefined;
  const probe = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 5000,
  });
  if (probe.error || probe.status !== 0) return undefined;
  const text = `${probe.stdout}\n${probe.stderr}`;
  if (!/bwrap|bubblewrap/i.test(text)) return undefined;
  if (!probeBwrapUserns(bin)) return undefined;
  return bin;
}

export function detectSandbox(): { backend: SandboxBackend; hardened: boolean } {
  if (findRunnableBwrap()) {
    return { backend: "bwrap", hardened: tryRealpath(process.execPath) !== undefined };
  }
  if (process.platform === "darwin") {
    const seatbelt = findOnPath("sandbox-exec", true);
    if (seatbelt) return { backend: "seatbelt", hardened: true };
  }
  return { backend: "copy", hardened: false };
}

export function assertExecuteSandbox(config: LegionConfig, flags: { allowNoSandbox?: boolean }): void {
  if (flags.allowNoSandbox) return;
  const detected = detectSandbox();
  const requested = config.sandbox.backend;
  const hardened =
    requested === "copy"
      ? false
      : requested === "auto"
        ? detected.hardened
        : detected.backend === requested && detected.hardened;
  if (config.sandbox.requireHardened && !hardened && !config.sandbox.allowCopyJail) {
    throw new SandboxError(HARDENED_REQUIRED);
  }
}

function assertPolicyPath(posix: string): string {
  if (!isConcretePosixRepoRelativePath(posix) || isBlockedRel(posix)) {
    throw new PathEscapeError(posix);
  }
  return posix;
}

function assertSafeRunId(runId: string): string {
  if (!isConcretePosixRepoRelativePath(runId) || runId.includes("/")) {
    throw new PathEscapeError(runId);
  }
  return runId;
}

function unique(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function isBlockedName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "node_modules" || lower === ".git";
}

function isBlockedRel(posix: string): boolean {
  return posix.split("/").some((part) => isBlockedName(part));
}

function isJailMeta(rel: string): boolean {
  return (
    rel === "home" ||
    rel.startsWith("home/") ||
    rel === "tmp" ||
    rel.startsWith("tmp/") ||
    rel === ".git-null" ||
    rel.startsWith(".git-null/") ||
    rel === "node_modules" ||
    rel.startsWith("node_modules/")
  );
}

function matchesAllowed(posix: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => posix === entry || posix.startsWith(`${entry}/`));
}

function lexicalRel(root: string, abs: string): string | undefined {
  const posix = toPosixPath(relative(resolve(root), resolve(abs)));
  if (posix === "" || posix === ".") return ".";
  if (posix === ".." || posix.startsWith("../") || /^[A-Za-z]:/.test(posix) || posix.startsWith("/")) {
    return undefined;
  }
  return posix;
}

function canonicalBlocked(projectRoot: string, abs: string): boolean {
  try {
    return isBlockedRel(toProjectRelativePosix(projectRoot, abs));
  } catch {
    return true;
  }
}

function buildSandboxEnv(jailRoot: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = join(jailRoot, "home");
  const tmp = join(jailRoot, "tmp");
  const env: NodeJS.ProcessEnv = {};
  const pathVal = source.PATH ?? source.Path;
  if (pathVal !== undefined) env.PATH = pathVal;
  if (source.TERM !== undefined) env.TERM = source.TERM;
  if (process.platform === "win32") {
    for (const key of WINDOWS_INHERIT) {
      const value = source[key];
      if (value !== undefined) env[key] = value;
    }
  }
  env.TEMP = tmp;
  env.TMP = tmp;
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = home;
  env.LOCALAPPDATA = home;
  env.GIT_DIR = join(jailRoot, ".git-null");
  for (const key of ADAPTER_CREDENTIAL_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function homeRealpaths(): string[] {
  const out: string[] = [];
  for (const raw of [process.env.HOME, process.env.USERPROFILE, homedir()]) {
    if (!raw) continue;
    const real = tryRealpath(raw) ?? resolve(raw);
    if (!out.some((entry) => samePath(entry, real))) out.push(real);
  }
  return out;
}

function isUnsafeDirname(dir: string, projectRoot: string): boolean {
  const real = tryRealpath(dir) ?? resolve(dir);
  if (samePath(real, dirname(real))) return true;
  if (toPosixPath(real) === "/") return true;
  if (homeRealpaths().some((home) => samePath(real, home))) return true;
  if (samePath(real, projectRoot)) return true;
  const projectReal = tryRealpath(projectRoot) ?? resolve(projectRoot);
  const rel = toPosixPath(relative(projectReal, real));
  if (rel !== ".." && !rel.startsWith("../") && !/^[A-Za-z]:/.test(rel) && !rel.startsWith("/")) return true;
  return false;
}

function realpathsToBind(adapterBinary?: string): { paths: string[]; ok: boolean } {
  const execReal = tryRealpath(process.execPath);
  if (!execReal) return { paths: [], ok: false };
  const paths = [execReal];
  if (!adapterBinary) return { paths, ok: true };
  const resolved =
    adapterBinary.includes("/") || adapterBinary.includes("\\") || /^[A-Za-z]:/.test(adapterBinary)
      ? adapterBinary
      : findOnPath(adapterBinary);
  const real = resolved ? tryRealpath(resolved) : undefined;
  if (!real) return { paths, ok: false };
  if (!paths.some((entry) => samePath(entry, real))) paths.push(real);
  if (resolved && !paths.some((entry) => samePath(entry, resolved))) paths.push(resolved);
  return { paths, ok: true };
}

function bwrapArgvPrefix(opts: { jailRoot: string; projectRoot: string; bindPaths: readonly string[] }): string[] {
  const args = [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];
  const seenDest = new Set<string>();
  const roBind = (source: string, dest = source) => {
    if (!existsSync(source) || seenDest.has(dest)) return;
    seenDest.add(dest);
    args.push("--ro-bind", source, dest);
  };
  for (const path of SYSTEM_RO_BINDS) roBind(path);
  for (const path of opts.bindPaths) {
    roBind(path);
    const dir = dirname(path);
    if (!isUnsafeDirname(dir, opts.projectRoot)) roBind(dir);
  }
  args.push("--tmpfs", "/tmp", "--bind", opts.jailRoot, opts.jailRoot);
  const nodeModules = join(opts.projectRoot, "node_modules");
  if (existsSync(nodeModules)) {
    args.push("--ro-bind", nodeModules, join(opts.jailRoot, "node_modules"));
  }
  args.push("--setenv", "HOME", join(opts.jailRoot, "home"));
  args.push("--chdir", opts.jailRoot, "--");
  return args;
}

function seatbeltProfile(jailRoot: string): string {
  const sub = JSON.stringify(jailRoot);
  const reads = [sub, ...SYSTEM_RO_BINDS.filter((path) => existsSync(path)).map((path) => JSON.stringify(path))];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow network*)",
    `(allow file-read* ${reads.map((path) => `(subpath ${path})`).join(" ")})`,
    `(allow file-write* (subpath ${sub}))`,
    `(allow file-ioctl (subpath ${sub}))`,
    "",
  ].join("\n");
}

async function copyTree(
  src: string,
  dest: string,
  projectRoot: string,
  depth = 0,
  seenDest?: Set<string>,
  srcStack?: Set<string>,
): Promise<void> {
  if (depth > MAX_COPY_DEPTH) {
    throw new SandboxError(`sandbox copy exceeded ${MAX_COPY_DEPTH} directory levels`);
  }
  const visitedDest = seenDest ?? new Set<string>();
  const walkSrc = srcStack ?? new Set<string>();
  let st;
  try {
    st = await lstat(src);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    const real = tryRealpath(src);
    if (!real) return;
    if (walkSrc.has(resolve(real))) return;
    if (canonicalBlocked(projectRoot, real)) return;
    await copyTree(real, dest, projectRoot, depth + 1, visitedDest, walkSrc);
    return;
  }
  if (canonicalBlocked(projectRoot, src)) return;
  const srcKey = tryRealpath(src) ?? resolve(src);
  if (walkSrc.has(srcKey)) return;
  const destKey = resolve(dest);
  if (visitedDest.has(destKey)) return;
  visitedDest.add(destKey);
  walkSrc.add(srcKey);
  try {
    if (st.isDirectory()) {
      await mkdir(dest, { recursive: true });
      const entries = await readdir(src, { withFileTypes: true });
      for (const entry of entries) {
        if (isBlockedName(entry.name)) continue;
        if (entry.name === "sandbox" && toPosixPath(relative(projectRoot, src)).replace(/\\/g, "/") === ".legion-cli") {
          continue;
        }
        await copyTree(
          join(src, entry.name),
          join(dest, entry.name),
          projectRoot,
          depth + 1,
          visitedDest,
          walkSrc,
        );
      }
      return;
    }
    if (!st.isFile()) return;
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  } finally {
    walkSrc.delete(srcKey);
  }
}

async function copySparsePath(
  projectRoot: string,
  jailRoot: string,
  posix: string,
  mkdirIfMissing: boolean,
): Promise<void> {
  assertPolicyPath(posix);
  if (isBlockedRel(posix)) return;
  const src = toFsPath(projectRoot, posix);
  const dest = toFsPath(jailRoot, posix);
  if (lexicalRel(jailRoot, dest) === undefined) throw new PathEscapeError(dest);
  try {
    await lstat(src);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && mkdirIfMissing) {
      await mkdir(dirname(dest), { recursive: true });
      return;
    }
    if (code === "ENOENT") return;
    throw err;
  }
  if (canonicalBlocked(projectRoot, src)) return;
  await copyTree(src, dest, projectRoot);
}

async function listJailFiles(jailRoot: string, allowedWrites: readonly string[] = []): Promise<string[]> {
  const out: string[] = [];
  const stack = [jailRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = toPosixPath(relative(jailRoot, abs));
      if (rel === "" || (isJailMeta(rel) && !matchesAllowed(rel, allowedWrites))) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(abs);
        continue;
      }
      out.push(rel);
    }
  }
  return out;
}

async function pathHasSymlinkAncestor(abs: string, root: string): Promise<boolean> {
  let current = resolve(abs);
  const stop = resolve(root);
  for (;;) {
    if (samePath(current, stop)) break;
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parent = dirname(current);
    if (samePath(parent, current)) return true;
    current = parent;
  }
  return false;
}

async function destIsUnsafe(projectRoot: string, dest: string): Promise<boolean> {
  const lexical = lexicalRel(projectRoot, dest);
  if (!lexical || lexical === "." || isBlockedRel(lexical)) return true;
  return pathHasSymlinkAncestor(dest, projectRoot);
}

async function parentIsUnsafe(projectRoot: string, parent: string): Promise<boolean> {
  if (samePath(parent, projectRoot)) return false;
  const lexical = lexicalRel(projectRoot, parent);
  if (!lexical || isBlockedRel(lexical)) return true;
  return pathHasSymlinkAncestor(parent, projectRoot);
}

async function safeCopyOutFile(src: string, dest: string, projectRoot: string): Promise<boolean> {
  if (await destIsUnsafe(projectRoot, dest)) return false;
  const parent = dirname(dest);
  if (await parentIsUnsafe(projectRoot, parent)) return false;
  await mkdir(parent, { recursive: true });
  if (await destIsUnsafe(projectRoot, dest)) return false;
  const parentReal = tryRealpath(parent);
  if (parentReal && canonicalBlocked(projectRoot, parentReal)) return false;
  const destReal = tryRealpath(dest);
  if (destReal && canonicalBlocked(projectRoot, destReal)) return false;
  const tmp = join(parent, `.legion-copyout-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    await copyFile(src, tmp);
    try {
      const destSt = await lstat(dest);
      if (destSt.isSymbolicLink()) {
        await rm(tmp, { force: true });
        return false;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await rename(tmp, dest);
    return true;
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function copyOutWrites(
  projectRoot: string,
  jailRoot: string,
  allowedWrites: readonly string[],
): Promise<{ copied: string[]; dropped: string[] }> {
  const copied: string[] = [];
  const dropped: string[] = [];
  const files = (await listJailFiles(jailRoot, allowedWrites)).sort();
  for (const rel of files) {
    let src: string;
    try {
      src = toFsPath(jailRoot, rel);
    } catch {
      dropped.push(rel);
      continue;
    }
    let st;
    try {
      st = await lstat(src);
    } catch {
      dropped.push(rel);
      continue;
    }
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      isBlockedRel(rel) ||
      !isConcretePosixRepoRelativePath(rel) ||
      !matchesAllowed(rel, allowedWrites)
    ) {
      dropped.push(rel);
      continue;
    }
    const dest = toFsPath(projectRoot, rel);
    if (!(await safeCopyOutFile(src, dest, projectRoot))) {
      dropped.push(rel);
      continue;
    }
    copied.push(rel);
  }
  const jailSet = new Set(files);
  for (const allowed of allowedWrites) {
    if (jailSet.has(allowed) || isBlockedRel(allowed)) continue;
    let dest: string;
    try {
      dest = toFsPath(projectRoot, allowed);
    } catch {
      continue;
    }
    try {
      const destSt = await lstat(dest);
      if (!destSt.isFile() || destSt.isSymbolicLink()) continue;
      if (await destIsUnsafe(projectRoot, dest)) continue;
      await rm(dest, { force: true });
      copied.push(allowed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return { copied, dropped };
}

export async function materializeJail(policy: SandboxPolicy): Promise<SandboxHandle> {
  const projectRoot = resolve(policy.projectRoot);
  const runId = assertSafeRunId(policy.runId);
  const allowedWrites = unique(policy.allowedWrites.map(assertPolicyPath));
  const readSet = unique(policy.readSet.map(assertPolicyPath));

  const jailRoot = toFsPath(projectRoot, `.legion-cli/sandbox/${runId}`);
  const sandboxDir = legionPaths(projectRoot).sandboxDir;
  if (await pathHasSymlinkAncestor(sandboxDir, projectRoot) || await pathHasSymlinkAncestor(jailRoot, projectRoot)) {
    throw new SandboxError("sandbox directory is a symlink");
  }
  await rm(jailRoot, { recursive: true, force: true });
  await mkdir(jailRoot, { recursive: true });
  await mkdir(join(jailRoot, "home"), { recursive: true });
  await mkdir(join(jailRoot, "tmp"), { recursive: true });
  await mkdir(join(jailRoot, ".git-null"), { recursive: true });

  const extraFiles: string[] = [];
  const destroyCreated = async () => {
    await rm(jailRoot, { recursive: true, force: true });
    for (const file of extraFiles) await rm(file, { force: true });
  };

  try {
    for (const posix of readSet) {
      await copySparsePath(projectRoot, jailRoot, posix, false);
    }
    for (const posix of allowedWrites) {
      await copySparsePath(projectRoot, jailRoot, posix, true);
    }

    const detected = detectSandbox();
    const requested = policy.backend ?? "auto";
    const selected: SandboxBackend =
      requested === "auto" ? detected.backend : requested;
    if (requested !== "auto" && detected.backend !== requested && requested !== "copy") {
      if (requested === "bwrap" && !findRunnableBwrap()) throw new SandboxError(HARDENED_REQUIRED);
      if (requested === "seatbelt" && !findOnPath("sandbox-exec", true)) throw new SandboxError(HARDENED_REQUIRED);
    }
    const binds = realpathsToBind(policy.adapterBinary);
    const env = buildSandboxEnv(jailRoot, policy.env ?? process.env);
    let wrapper: { bin: string; argvPrefix: string[] } | undefined;
    let backend: SandboxBackend = "copy";
    let hardened = false;

    if (selected === "copy") {
      backend = "copy";
      hardened = false;
    } else {
      if (!binds.ok) {
        throw new SandboxError(HARDENED_REQUIRED);
      }
      if (selected === "bwrap") {
        const bin = findRunnableBwrap();
        if (!bin) throw new SandboxError(HARDENED_REQUIRED);
        wrapper = { bin, argvPrefix: bwrapArgvPrefix({ jailRoot, projectRoot, bindPaths: binds.paths }) };
      } else {
        const bin = findOnPath("sandbox-exec", true);
        if (!bin) throw new SandboxError(HARDENED_REQUIRED);
        const profilePath = join(legionPaths(projectRoot).sandboxDir, `${runId}.sb`);
        await mkdir(dirname(profilePath), { recursive: true });
        try {
          const st = await lstat(profilePath);
          if (st.isSymbolicLink() || !st.isFile()) {
            throw new SandboxError("sandbox profile path is unsafe");
          }
          await rm(profilePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT" && !(err instanceof SandboxError)) throw err;
          if (err instanceof SandboxError) throw err;
        }
        await writeFile(profilePath, seatbeltProfile(jailRoot), { encoding: "utf8", flag: "wx" });
        extraFiles.push(profilePath);
        wrapper = { bin, argvPrefix: ["-f", profilePath, "--"] };
      }
      backend = selected;
      hardened = true;
    }

    return {
      backend,
      hardened,
      jailRoot,
      spawnOpts() {
        const next: { cwd: string; env: NodeJS.ProcessEnv; wrapper?: { bin: string; argvPrefix: string[] } } = {
          cwd: jailRoot,
          env: { ...env },
        };
        if (wrapper) next.wrapper = { bin: wrapper.bin, argvPrefix: [...wrapper.argvPrefix] };
        return next;
      },
      copyOut() {
        return copyOutWrites(projectRoot, jailRoot, allowedWrites);
      },
      async destroy() {
        await destroyCreated();
      },
    };
  } catch (err) {
    await destroyCreated();
    throw err;
  }
}
