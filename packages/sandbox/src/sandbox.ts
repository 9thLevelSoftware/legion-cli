import { existsSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import {
  PathEscapeError,
  canonicalizePath,
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
  network: "allow" | "deny";
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

function tryRealpath(target: string): string | undefined {
  try {
    return realpathSync(target);
  } catch {
    return undefined;
  }
}

function findOnPath(name: string): string | undefined {
  const pathVal = process.env.PATH ?? process.env.Path ?? "";
  const pathExt = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM") : "";
  const exts = process.platform === "win32" ? pathExt.split(";").filter(Boolean) : [""];
  const hasExt =
    process.platform === "win32" && exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  const names = process.platform === "win32" && !hasExt ? [name, ...exts.map((ext) => `${name}${ext}`)] : [name];
  for (const dir of pathVal.split(delimiter)) {
    if (!dir) continue;
    for (const candidateName of names) {
      const candidate = join(dir, candidateName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function detectSandbox(): { backend: SandboxBackend; hardened: boolean } {
  if (findOnPath("bwrap")) {
    return { backend: "bwrap", hardened: tryRealpath(process.execPath) !== undefined };
  }
  if (process.platform === "darwin" && findOnPath("sandbox-exec")) {
    return { backend: "seatbelt", hardened: true };
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
  if (!isConcretePosixRepoRelativePath(posix)) {
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

function isBlockedRel(posix: string): boolean {
  return posix.split("/").some((part) => part === "node_modules" || part === ".git");
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
  if (real !== execReal) paths.push(real);
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
  // Network stays shared: --unshare-net is intentionally omitted.
  const seenDest = new Set<string>();
  const roBind = (source: string, dest = source) => {
    if (!existsSync(source) || seenDest.has(dest)) return;
    seenDest.add(dest);
    args.push("--ro-bind", source, dest);
  };
  for (const path of SYSTEM_RO_BINDS) roBind(path);
  for (const path of opts.bindPaths) {
    roBind(path);
    roBind(dirname(path));
  }
  args.push("--tmpfs", "/tmp", "--bind", opts.jailRoot, opts.jailRoot);
  const nodeModules = join(opts.projectRoot, "node_modules");
  if (existsSync(nodeModules)) {
    args.push("--ro-bind", nodeModules, join(opts.jailRoot, "node_modules"));
  }
  args.push("--chdir", opts.jailRoot, "--");
  return args;
}

function seatbeltProfile(jailRoot: string): string {
  const sub = JSON.stringify(jailRoot);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow network*)",
    "(allow file-read*)",
    `(allow file-write* (subpath ${sub}))`,
    `(allow file-ioctl (subpath ${sub}))`,
    "",
  ].join("\n");
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
  toProjectRelativePosix(jailRoot, dest);
  let st;
  try {
    st = await lstat(src);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && mkdirIfMissing) {
      await mkdir(dirname(dest), { recursive: true });
      return;
    }
    if (code === "ENOENT") return;
    throw err;
  }
  toProjectRelativePosix(projectRoot, canonicalizePath(src));
  await mkdir(dirname(dest), { recursive: true });
  if (st.isDirectory()) {
    await cp(src, dest, {
      recursive: true,
      filter: (from) => {
        const rel = toPosixPath(relative(src, from));
        if (rel === "" || rel === ".") return true;
        return !isBlockedRel(rel);
      },
    });
    return;
  }
  await cp(src, dest);
}

async function listJailFiles(jailRoot: string): Promise<string[]> {
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
      if (rel === "" || isJailMeta(rel)) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(abs);
        continue;
      }
      out.push(rel);
    }
  }
  return out;
}

async function copyOutWrites(
  projectRoot: string,
  jailRoot: string,
  allowedWrites: readonly string[],
): Promise<{ copied: string[]; dropped: string[] }> {
  const copied: string[] = [];
  const dropped: string[] = [];
  const files = (await listJailFiles(jailRoot)).sort();
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
      st.isSymbolicLink() ||
      isBlockedRel(rel) ||
      !isConcretePosixRepoRelativePath(rel) ||
      !matchesAllowed(rel, allowedWrites)
    ) {
      dropped.push(rel);
      continue;
    }
    const dest = toFsPath(projectRoot, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest);
    copied.push(rel);
  }
  return { copied, dropped };
}

export async function materializeJail(policy: SandboxPolicy): Promise<SandboxHandle> {
  const projectRoot = resolve(policy.projectRoot);
  const runId = assertSafeRunId(policy.runId);
  const allowedWrites = unique(policy.allowedWrites.map(assertPolicyPath));
  const readSet = unique(policy.readSet.map(assertPolicyPath));

  const jailRoot = toFsPath(projectRoot, `.legion-cli/sandbox/${runId}`);
  await rm(jailRoot, { recursive: true, force: true });
  await mkdir(jailRoot, { recursive: true });
  await mkdir(join(jailRoot, "home"), { recursive: true });
  await mkdir(join(jailRoot, "tmp"), { recursive: true });
  await mkdir(join(jailRoot, ".git-null"), { recursive: true });

  for (const posix of readSet) {
    await copySparsePath(projectRoot, jailRoot, posix, false);
  }
  for (const posix of allowedWrites) {
    await copySparsePath(projectRoot, jailRoot, posix, true);
  }

  const detected = detectSandbox();
  const binds = realpathsToBind(policy.adapterBinary);
  const backend = detected.backend;
  let hardened = detected.hardened && binds.ok;
  const env = buildSandboxEnv(jailRoot);
  const extraFiles: string[] = [];
  let wrapper: { bin: string; argvPrefix: string[] } | undefined;

  if (backend === "bwrap" && hardened) {
    const bin = findOnPath("bwrap");
    if (bin) {
      wrapper = { bin, argvPrefix: bwrapArgvPrefix({ jailRoot, projectRoot, bindPaths: binds.paths }) };
    } else {
      hardened = false;
    }
  } else if (backend === "seatbelt" && hardened) {
    const bin = findOnPath("sandbox-exec");
    if (bin) {
      const profilePath = join(legionPaths(projectRoot).sandboxDir, `${runId}.sb`);
      await mkdir(dirname(profilePath), { recursive: true });
      await writeFile(profilePath, seatbeltProfile(jailRoot), "utf8");
      extraFiles.push(profilePath);
      wrapper = { bin, argvPrefix: ["-f", profilePath] };
    } else {
      hardened = false;
    }
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
      await rm(jailRoot, { recursive: true, force: true });
      for (const file of extraFiles) await rm(file, { force: true });
    },
  };
}
