import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertAgentControlPathAllowed,
  assertAgentPathAllowed,
  isEngineProtectedPath,
  overlapsEngineProtectedPath,
  PathEscapeError,
  legionPaths,
  toFsPath,
  toPosixPath,
  toProjectRelativePosix,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  isConcretePosixRepoRelativePath,
  type LegionConfig,
  type SandboxConfig,
} from "@9thlevelsoftware/legion-cli-schema";
import { dockerArgvPrefix, findRunnableDocker, translateHostPathToDocker } from "./docker.js";
import { SandboxError } from "./errors.js";

export type SandboxBackend = "bwrap" | "seatbelt" | "copy" | "docker";

export type SandboxPolicy = {
  projectRoot: string;
  runId: string;
  allowedWrites: readonly string[];
  readSet: readonly string[];
  adapterBinary?: string;
  backend?: SandboxBackend | "auto";
  /** When LSM bind fails, copy jail is allowed only if a hatch was already granted. */
  allowDegradedCopy?: boolean;
  /** Adapter-scoped vendor keys only; never the full credential dump. */
  credentialKeys?: readonly string[];
  /** Required identity of a retained jail when reopening after interruption. */
  expectedIdentity?: string;
};

export type SandboxOutputChange = {
  path: string;
  action: "write" | "delete";
  /** Hash observed when the jail was materialized; null means the path did not exist. */
  beforeHash: string | null;
  /** Hash observed during inspection for writes. */
  afterHash?: string;
  /** Immutable inspected bytes so application does not depend on a writable jail. */
  content?: Buffer;
};

export type SandboxOutput = {
  jailRoot: string;
  changes: SandboxOutputChange[];
  dropped: string[];
};

export type SandboxApplyResult = {
  copied: string[];
  dropped: string[];
  conflicts: string[];
};

export interface SandboxHandle {
  backend: SandboxBackend;
  hardened: boolean;
  jailRoot: string;
  /** Hash of immutable recovery metadata, including its random creation nonce. */
  identity: string;
  spawnOpts(): {
    cwd: string;
    env: NodeJS.ProcessEnv;
    wrapper?: { bin: string; argvPrefix: string[] };
    translateInvoke: (invoke: string) => string;
  };
  inspectOutput(): Promise<SandboxOutput>;
  applyOutput(output: SandboxOutput): Promise<SandboxApplyResult>;
  copyOut(): Promise<{ copied: string[]; dropped: string[] }>;
  destroy(): Promise<void>;
}

type SandboxResumeRecord = {
  version: 2;
  runId: string;
  nonce: string;
  backend: SandboxBackend;
  hardened: boolean;
  allowedWrites: string[];
  copyInHashes: Array<[string, string]>;
};

function sandboxIdentity(record: SandboxResumeRecord): string {
  return createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex");
}

async function assertJailIdentitySentinel(projectRoot: string, runId: string, nonce: string): Promise<void> {
  const jailRoot = toFsPath(projectRoot, `.legion-cli/sandbox/${runId}`);
  const sentinel = toFsPath(jailRoot, JAIL_IDENTITY_REL);
  let info;
  let raw: unknown;
  try {
    info = await lstat(sentinel);
    raw = JSON.parse(await readFile(sentinel, "utf8"));
  } catch (err) {
    throw new SandboxError("sandbox recovery sentinel is unavailable", { cause: err });
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new SandboxError("sandbox recovery sentinel is unsafe");
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as { version?: unknown }).version !== 1 ||
    (raw as { runId?: unknown }).runId !== runId ||
    (raw as { nonce?: unknown }).nonce !== nonce
  ) throw new SandboxError("sandbox recovery sentinel mismatch");
}

function sandboxResumePath(projectRoot: string, runId: string): string {
  return toFsPath(projectRoot, `.legion-cli/cache/runs/${runId}/sandbox.json`);
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

/**
 * Realpath of the deepest existing ancestor of `path` with the missing tail appended. Seatbelt matches the
 * kernel's resolved vnode path, so a rule naming `/var/folders/...` never matches; it must name `/private/var/...`.
 */
function canonicalPathSync(path: string): string {
  const absolute = resolve(path);
  const tail: string[] = [];
  let cursor = absolute;
  for (;;) {
    const real = tryRealpath(cursor);
    if (real) return join(real, ...tail.reverse());
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    tail.push(relative(parent, cursor));
    cursor = parent;
  }
}

/** The given and canonical spellings of a path, for deny rules that must hold under either name. */
function seatbeltSpellings(path: string): string[] {
  const given = resolve(path);
  return [...new Set([given, canonicalPathSync(given)])];
}

function seatbeltSubpaths(paths: readonly string[]): string {
  return [...new Set(paths)].map((path) => `(subpath ${JSON.stringify(path)})`).join(" ");
}

/**
 * Path resolution (realpath, module loading, getcwd) stats every ancestor of a readable root. The kernel names
 * each stat'ed node by its canonical parent plus its own name, so an alias component (macOS `/var`, a linked
 * project directory) is granted as that link node and its target directories in canonical form. Metadata only:
 * no file data or directory listing.
 */
function seatbeltAncestorMetadataRule(roots: readonly string[]): string {
  const nodes = new Set<string>();
  for (const root of roots) {
    let cursor = resolve(root);
    for (;;) {
      const parent = dirname(cursor);
      const canonical = canonicalPathSync(cursor);
      const linkNode = parent === cursor ? cursor : join(canonicalPathSync(parent), basename(cursor));
      if (linkNode !== canonical) nodes.add(linkNode);
      if (cursor !== resolve(root)) nodes.add(canonical);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return `(allow file-read-metadata ${[...nodes].sort().map((path) => `(literal ${JSON.stringify(path)})`).join(" ")})`;
}

/**
 * macOS runtime a `(deny default)` profile must grant before node or a CLI tool can start: dyld/libSystem
 * framework reads and executable mappings, standard system aliases, devices, libinfo/logging services.
 * Adapted from OpenAI Codex's tested `:minimal` Seatbelt platform defaults
 * (codex-rs/sandboxing/src/seatbelt_read_only_platform_defaults.sbpl). System locations only: no user home,
 * project, or temporary-directory data is readable through these rules.
 */
const SEATBELT_DARWIN_RUNTIME_RULES = [
  `(allow file-read* file-test-existence (subpath "/Library/Apple") (subpath "/Library/Filesystems/NetFSPlugins") (subpath "/Library/Preferences/Logging") (subpath "/private/var/db/timezone") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/Library/Preferences") (subpath "/private/var/db"))`,
  `(allow file-map-executable (subpath "/Library/Apple/System/Library/Frameworks") (subpath "/Library/Apple/System/Library/PrivateFrameworks") (subpath "/Library/Apple/usr/lib") (subpath "/System/Library/Extensions") (subpath "/System/Library/Frameworks") (subpath "/System/Library/PrivateFrameworks") (subpath "/System/Library/SubFrameworks") (subpath "/usr/lib"))`,
  `(allow file-read* file-test-existence (subpath "/Library/Apple/System/Library/Frameworks") (subpath "/Library/Apple/System/Library/PrivateFrameworks") (subpath "/Library/Apple/usr/lib") (subpath "/System/Library/Frameworks") (subpath "/System/Library/PrivateFrameworks") (subpath "/System/Library/SubFrameworks") (subpath "/usr/lib"))`,
  `(allow system-mac-syscall (mac-policy-name "vnguard"))`,
  `(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))`,
  `(allow file-read-metadata file-test-existence (literal "/etc") (literal "/tmp") (literal "/var") (literal "/private/etc/localtime"))`,
  `(allow file-read-metadata file-test-existence (path-ancestors "/System/Volumes/Data/private"))`,
  `(allow file-read* file-test-existence (literal "/"))`,
  `(allow file-read* file-test-existence (literal "/dev/autofs_nowait") (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/master.passwd") (literal "/private/etc/passwd") (literal "/private/etc/protocols") (literal "/private/etc/services"))`,
  `(allow file-read* file-test-existence file-write-data (literal "/dev/null") (literal "/dev/zero"))`,
  `(allow file-read-data file-test-existence file-write-data (subpath "/dev/fd"))`,
  `(allow file-read* file-test-existence file-write-data file-ioctl (literal "/dev/dtracehelper"))`,
  `(allow file-read* (subpath "/private/etc"))`,
  `(allow file-read* file-test-existence (literal "/System/Library/CoreServices") (literal "/System/Library/CoreServices/.SystemVersionPlatform.plist") (literal "/System/Library/CoreServices/SystemVersion.plist"))`,
  // Node's bundled OpenSSL opens OPENSSLDIR/openssl.cnf at startup; EPERM there is fatal (ENOENT is not).
  `(allow file-read* (subpath "/System/Library/OpenSSL"))`,
  `(allow file-read-metadata (subpath "/var"))`,
  `(allow file-read-metadata (subpath "/private/var"))`,
  `(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))`,
  `(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.DirectoryService.libinfo_v1") (global-name "com.apple.system.opendirectoryd.membership") (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.system.logger") (global-name "com.apple.logd") (global-name "com.apple.logd.events") (global-name "com.apple.diagnosticd") (global-name "com.apple.system.notification_center") (global-name "com.apple.secinitd") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.analyticsd") (global-name "com.apple.analyticsd.messagetracer") (global-name "com.apple.PowerManagement.control"))`,
  `(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))`,
  `(allow file-read-data file-read-metadata (subpath "/bin") (subpath "/sbin") (subpath "/usr/bin") (subpath "/usr/sbin") (subpath "/usr/libexec"))`,
  `(allow file-read* (subpath "/opt/homebrew/lib") (subpath "/usr/local/lib"))`,
  `(allow file-read* (regex "^/dev/fd/(0|1|2)$"))`,
  `(allow file-write* (regex "^/dev/fd/(1|2)$"))`,
  `(allow file-read* file-write* (literal "/dev/null") (literal "/dev/tty"))`,
  `(allow file-read-metadata (literal "/dev") (regex "^/dev/.*$"))`,
  `(allow file-read-metadata (literal "/System/Volumes") (vnode-type DIRECTORY))`,
  `(allow file-read-metadata (literal "/System/Volumes/Data") (vnode-type DIRECTORY))`,
  `(allow file-read-metadata (literal "/System/Volumes/Data/Users") (vnode-type DIRECTORY))`,
] as const;

export function findOnPath(name: string, rejectStubs = false): string | undefined {
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
  if (findRunnableDocker()) {
    return { backend: "docker", hardened: true };
  }
  return { backend: "copy", hardened: false };
}

/** True when the configured backend resolves to a real OS sandbox (bwrap, seatbelt or Docker), not the copy jail. */
export function hardenedSandboxAvailable(sandbox: Pick<SandboxConfig, "backend">): boolean {
  const detected = detectSandbox();
  const requested = sandbox.backend;
  return requested === "copy"
    ? false
    : requested === "auto"
      ? detected.hardened
      : detected.backend === requested && detected.hardened;
}

export function assertExecuteSandbox(config: LegionConfig, flags: { allowNoSandbox?: boolean }): void {
  if (flags.allowNoSandbox) return;
  const hardened = hardenedSandboxAvailable(config.sandbox);
  if (config.sandbox.requireHardened && !hardened && !config.sandbox.allowCopyJail) {
    throw new SandboxError(HARDENED_REQUIRED);
  }
}

export type VerifyTrustTier = "hardened-bwrap" | "hardened-seatbelt" | "hardened-docker" | "allowlist";

export type VerificationTrustFlags = {
  /** Ignored: verify never requires --allow-no-sandbox. */
  allowNoSandbox?: boolean;
  platform?: NodeJS.Platform;
  dockerAvailable?: boolean;
  bwrapAvailable?: boolean;
  seatbeltAvailable?: boolean;
};

export type VerificationTrustPosture = {
  tier: VerifyTrustTier;
  note: string;
  backend: SandboxBackend | "host";
  /** Copy jail is execute opt-in only; verify never copies the tree (A-007). */
  copyJail: false;
  error?: string;
};

export type VerificationWrapper = {
  bin: string;
  argvPrefix: string[];
  translateInvoke?: (invoke: string) => string;
};
export type VerificationInformationFlow = {
  /** Engine package roots hidden from verification (unreadable and unwritable). */
  installedEnginePaths: readonly string[];
  /**
   * Realpaths of the engine's transitive runtime module closure. Roots inside the project are mounted
   * read-only so product tests can import shared dependencies but never rewrite code the engine loads later.
   * Roots outside the project are already unwritable (only the project root is writable).
   */
  readOnlyEnginePaths?: readonly string[];
};

export type VerificationWrapperOptions = {
  informationFlow?: VerificationInformationFlow;
};
/**
 * Paths verification may neither read nor write, spelled under the given project root. The root itself may be
 * reached through an alias (macOS /var → /private/var), but a protected path must not be a link or sit beneath one.
 */
function protectedVerificationPaths(projectRoot: string, informationFlow?: VerificationInformationFlow): string[] {
  if (!informationFlow) return [];
  const root = resolve(projectRoot);
  const rootReal = realpathSync(root);
  const enginePaths = informationFlow.installedEnginePaths.map((path) => {
    if (!isAbsolute(path)) throw new SandboxError("information-flow engine paths must be absolute");
    return resolve(path);
  });
  const candidates = [
    ...VERIFY_READONLY_RELS.filter((rel) => existsSync(join(root, rel))).map((rel) => join(root, rel)),
    ...enginePaths,
  ];
  const unique = [...new Set(candidates.map((path) => {
    if (!existsSync(path)) throw new SandboxError("information-flow verification protected path is unavailable");
    const real = realpathSync(path);
    const viaRootAlias = isWithin(root, path) && samePath(real, join(rootReal, relative(root, path)));
    if (!samePath(real, path) && !viaRootAlias) throw new SandboxError("information-flow verification protected path is aliased");
    if (isWithin(real, rootReal)) throw new SandboxError("information-flow engine exclusion cannot contain the project root");
    return isWithin(rootReal, real) ? join(root, relative(rootReal, real)) : real;
  }))];
  return unique.filter((path) => !unique.some((parent) => {
    const nested = relative(parent, path);
    return parent !== path && nested !== "" && !nested.startsWith("..") && !isAbsolute(nested);
  }));
}

function isWithin(parent: string, path: string): boolean {
  const nested = relative(parent, path);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

/**
 * In-sandbox read-only mounts covering every project-local engine runtime root. A root below a project
 * `node_modules` is covered by the outermost such directory, not by its own package directory: a writable parent
 * would let verification rename it or a resolution symlink (pnpm) aside and plant a replacement that the engine
 * resolves later. Product tests can still import from it. Closure realpaths are re-rooted when the project root is
 * reached through a symlink. Roots outside the project are omitted: verification can write only below the project.
 */
function readOnlyEngineMounts(projectRoot: string, informationFlow: VerificationInformationFlow | undefined, hidden: readonly string[]): string[] {
  if (!informationFlow?.readOnlyEnginePaths?.length) return [];
  const root = resolve(projectRoot);
  const rootReal = realpathSync(root);
  const mounts = new Set<string>();
  for (const input of informationFlow.readOnlyEnginePaths) {
    if (!isAbsolute(input)) throw new SandboxError("information-flow engine paths must be absolute");
    const path = resolve(input);
    if (!existsSync(path)) throw new SandboxError("information-flow verification protected path is unavailable");
    if (!samePath(realpathSync(path), path)) throw new SandboxError("information-flow verification protected path is aliased");
    if (isWithin(path, rootReal)) throw new SandboxError("information-flow engine exclusion cannot contain the project root");
    if (!isWithin(rootReal, path)) continue;
    const segments = relative(rootReal, path).split(sep);
    const modules = segments.indexOf("node_modules");
    const mount = join(root, ...(modules >= 0 ? segments.slice(0, modules + 1) : segments));
    if (hidden.some((parent) => isWithin(parent, mount))) continue;
    mounts.add(mount);
  }
  const unique = [...mounts];
  return unique.filter((path) => !unique.some((parent) => parent !== path && isWithin(parent, path))).sort();
}

function bwrapHidePathArgs(paths: readonly string[]): string[] {
  const args: string[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) args.push("--tmpfs", path);
    else args.push("--ro-bind", "/dev/null", path);
  }
  return args;
}

export const ALLOWLIST_TRUST_TIER_NOTE =
  "trust-tier: allowlist — verificationCommands run with your privileges (argv-only, shell-refused, scrubbed env); not a sandbox. Agent-authored verification is not a trust boundary.";

export const WINDOWS_ALLOWLIST_TRUST_TIER_NOTE =
  "trust-tier: allowlist — Windows without Docker: verificationCommands run with your privileges (argv-only, shell-refused, scrubbed env); not a sandbox. Agent-authored verification is not a trust boundary.";

function allowlistPosture(platform: NodeJS.Platform, note?: string): VerificationTrustPosture {
  return {
    tier: "allowlist",
    note:
      note ??
      (platform === "win32" ? WINDOWS_ALLOWLIST_TRUST_TIER_NOTE : ALLOWLIST_TRUST_TIER_NOTE),
    backend: "host",
    copyJail: false,
  };
}

/**
 * Per-platform verify posture (KD-4). requireHardened is execute's gate, not verify's:
 * applying it here would make --allow-no-sandbox the de-facto Windows invocation.
 * Docker is opt-in (`sandbox.backend: docker`); auto never selects it. Copy jail is never used.
 */
export function resolveVerificationTrustTier(
  sandbox: Pick<SandboxConfig, "backend" | "allowCopyJail" | "requireHardened">,
  flags: VerificationTrustFlags = {},
): VerificationTrustPosture {
  const platform = flags.platform ?? process.platform;
  const docker = flags.dockerAvailable ?? Boolean(findRunnableDocker());
  const bwrap = flags.bwrapAvailable ?? Boolean(findRunnableBwrap());
  const seatbelt =
    flags.seatbeltAvailable ?? (platform === "darwin" && Boolean(findOnPath("sandbox-exec", true)));

  if (sandbox.backend === "docker") {
    if (docker) {
      return {
        tier: "hardened-docker",
        note: "trust-tier: hardened-docker — verification runs under pinned Docker (opt-in)",
        backend: "docker",
        copyJail: false,
      };
    }
    return {
      tier: "hardened-docker",
      note: "trust-tier: hardened-docker — pinned Docker backend is not available",
      backend: "docker",
      copyJail: false,
      error: "pinned docker backend is not available for verification",
    };
  }

  if (sandbox.backend === "bwrap") {
    if (bwrap) {
      return {
        tier: "hardened-bwrap",
        note: "trust-tier: hardened-bwrap — verification runs under bubblewrap",
        backend: "bwrap",
        copyJail: false,
      };
    }
    return {
      tier: "hardened-bwrap",
      note: "trust-tier: hardened-bwrap — hardened bwrap is not available",
      backend: "bwrap",
      copyJail: false,
      error: "hardened bwrap is not available for verification",
    };
  }

  if (sandbox.backend === "seatbelt") {
    if (seatbelt) {
      return {
        tier: "hardened-seatbelt",
        note: "trust-tier: hardened-seatbelt — verification runs under seatbelt",
        backend: "seatbelt",
        copyJail: false,
      };
    }
    return {
      tier: "hardened-seatbelt",
      note: "trust-tier: hardened-seatbelt — seatbelt is not available",
      backend: "seatbelt",
      copyJail: false,
      error: "hardened seatbelt is not available for verification",
    };
  }

  if (sandbox.backend === "auto" && platform === "linux" && bwrap) {
    return {
      tier: "hardened-bwrap",
      note: "trust-tier: hardened-bwrap — verification runs under bubblewrap",
      backend: "bwrap",
      copyJail: false,
    };
  }
  if (sandbox.backend === "auto" && platform === "darwin" && seatbelt) {
    return {
      tier: "hardened-seatbelt",
      note: "trust-tier: hardened-seatbelt — verification runs under seatbelt",
      backend: "seatbelt",
      copyJail: false,
    };
  }

  if (sandbox.backend === "auto" && platform === "linux" && !bwrap) {
    return allowlistPosture(
      platform,
      "trust-tier: allowlist — hardened bwrap unavailable; verificationCommands run with your privileges (argv-only, shell-refused, scrubbed env); not a sandbox",
    );
  }

  return allowlistPosture(platform);
}

/**
 * Project-relative paths a verification command must not write: git hooks/config and the engine's
 * own state run later with the user's privileges (F-039). Read-only in the bwrap/seatbelt profiles.
 */
const VERIFY_READONLY_RELS = [".git", ".legion-cli", ".husky", ".githooks"] as const;

/** The subset of VERIFY_READONLY_RELS present in the project (bwrap/docker fail on a missing mount source). */
export function verificationReadOnlyRels(projectRoot: string): string[] {
  const root = resolve(projectRoot);
  return VERIFY_READONLY_RELS.filter((rel) => existsSync(join(root, rel)));
}

export function verificationBwrapArgvPrefix(
  projectRoot: string,
  options: VerificationWrapperOptions = {},
): string[] {
  const root = resolve(projectRoot);
  const args = [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    ...(options.informationFlow ? ["--unshare-net"] : []),
    "--dev",
    "/dev",
  ];
  if (existsSync("/proc")) args.push("--proc", "/proc");
  for (const path of SYSTEM_RO_BINDS) {
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  const execReal = tryRealpath(process.execPath);
  if (execReal) {
    args.push("--ro-bind", execReal, execReal);
    const dir = dirname(execReal);
    if (!isUnsafeDirname(dir, root)) args.push("--ro-bind", dir, dir);
  }
  args.push("--bind", root, root);
  for (const rel of verificationReadOnlyRels(root)) {
    const path = join(root, rel);
    args.push("--ro-bind", path, path);
  }
  if (options.informationFlow) {
    const hidden = protectedVerificationPaths(root, options.informationFlow);
    for (const path of readOnlyEngineMounts(root, options.informationFlow, hidden)) args.push("--ro-bind", path, path);
    args.push(...bwrapHidePathArgs(hidden));
  }
  args.push("--chdir", root, "--");
  return args;
}

/**
 * The verification runtime: the node binary, its directory, and on seatbelt its installation prefix (`<prefix>/bin/node`
 * → `<prefix>`), so node-bundled tools such as `npm` (`bin/npm` → `lib/node_modules/npm`) resolve. Each directory is
 * omitted when it is the filesystem root, a home directory, the project, or inside the project; the prefix is also
 * omitted when it contains a home directory.
 */
function verificationExecReadPaths(projectRoot: string): string[] {
  const root = resolve(projectRoot);
  const paths: string[] = [];
  const execReal = tryRealpath(process.execPath);
  if (!execReal) return paths;
  paths.push(execReal);
  const dir = dirname(execReal);
  if (isUnsafeDirname(dir, root)) return paths;
  paths.push(dir);
  const prefix = dirname(dir);
  if (basename(dir) === "bin" && !isUnsafeDirname(prefix, root) && !homeRealpaths().some((home) => isWithin(prefix, home))) {
    paths.push(prefix);
  }
  return paths;
}

export function verificationSeatbeltProfile(
  projectRoot: string,
  options: VerificationWrapperOptions = {},
): string {
  const root = resolve(projectRoot);
  const rootReal = canonicalPathSync(root);
  const execReads = verificationExecReadPaths(root).map((path) => canonicalPathSync(path));
  // Seatbelt matches canonical spellings (macOS /etc → /private/etc).
  const reads = [rootReal, ...SYSTEM_RO_BINDS.filter((path) => existsSync(path)).map(canonicalPathSync), ...execReads];
  const protectedPaths = options.informationFlow
    ? protectedVerificationPaths(root, options.informationFlow)
    : VERIFY_READONLY_RELS.map((rel) => join(root, rel));
  const readOnlyPaths = options.informationFlow ? readOnlyEngineMounts(root, options.informationFlow, protectedPaths) : [];
  const deniedReads = protectedPaths.flatMap(seatbeltSpellings);
  const deniedWrites = [...protectedPaths, ...readOnlyPaths].flatMap(seatbeltSpellings);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    ...SEATBELT_DARWIN_RUNTIME_RULES,
    ...(options.informationFlow ? [] : ["(allow network*)"]),
    seatbeltAncestorMetadataRule([root, ...reads]),
    `(allow file-read* ${seatbeltSubpaths(reads)})`,
    `(allow file-write* (subpath ${JSON.stringify(rootReal)}))`,
    ...(options.informationFlow && deniedReads.length > 0 ? [`(deny file-read* ${seatbeltSubpaths(deniedReads)})`] : []),
    ...(deniedWrites.length > 0 ? [`(deny file-write* ${seatbeltSubpaths(deniedWrites)})`] : []),
    `(allow file-ioctl (subpath ${JSON.stringify(rootReal)}))`,
    "",
  ].join("\n");
}

/** In-place wrapper: binds the project, never copies it (copy cost stays 0). */
export async function prepareVerificationWrapper(
  projectRoot: string,
  runId: string,
  posture: VerificationTrustPosture,
  options: VerificationWrapperOptions = {},
): Promise<VerificationWrapper | undefined> {
  const root = resolve(projectRoot);
  if (posture.backend === "host" || posture.error) return undefined;
  if (options.informationFlow && posture.backend === "copy") return undefined;
  if (posture.backend === "bwrap") {
    const bin = findRunnableBwrap();
    if (!bin) return undefined;
    return { bin, argvPrefix: verificationBwrapArgvPrefix(root, options) };
  }
  if (posture.backend === "docker") {
    const bin = findRunnableDocker();
    if (!bin) return undefined;
    const hiddenPaths = options.informationFlow ? protectedVerificationPaths(root, options.informationFlow) : [];
    const hiddenRels = hiddenPaths.map((path) => relative(root, path));
    if (hiddenRels.some((rel) => rel.startsWith("..") || isAbsolute(rel))) {
      throw new SandboxError("information-flow Docker verification cannot hide external engine paths");
    }
    if (hiddenPaths.some((path) => !statSync(path).isDirectory())) {
      throw new SandboxError("information-flow Docker verification can hide directories only");
    }
    const readOnlyEngineRels = options.informationFlow
      ? readOnlyEngineMounts(root, options.informationFlow, hiddenPaths).map((path) => relative(root, path).split(sep).join("/"))
      : [];
    return {
      bin,
      argvPrefix: dockerArgvPrefix({
        jailRoot: root,
        readOnlyRels: [...verificationReadOnlyRels(root), ...readOnlyEngineRels],
        ...(options.informationFlow ? { hiddenRels } : {}),
      }),
      translateInvoke: (invoke: string) => translateHostPathToDocker(invoke, root),
    };
  }
  const bin = findOnPath("sandbox-exec", true);
  if (!bin) return undefined;
  const safeId = assertSafeRunId(runId);
  const profilePath = join(legionPaths(root).cacheDir, "runs", safeId, "verify.sb");
  await mkdir(dirname(profilePath), { recursive: true });
  try {
    const st = await lstat(profilePath);
    if (st.isSymbolicLink() || !st.isFile()) throw new SandboxError("sandbox profile path is unsafe");
    await rm(profilePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await writeFile(profilePath, verificationSeatbeltProfile(root, options), { encoding: "utf8", flag: "wx" });
  return { bin, argvPrefix: ["-f", profilePath, "--"] };
}

function assertPolicyPath(posix: string): string {
  if (overlapsEngineProtectedPath(posix)) throw new PathEscapeError(posix);
  if (posix.includes("*")) {
    const placeholder = posix.replaceAll("*", "x");
    if (!isConcretePosixRepoRelativePath(placeholder) || isBlockedRel(placeholder)) {
      throw new PathEscapeError(posix);
    }
    return posix;
  }
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
  return lower === "node_modules" || lower === ".git" || lower === ".env" || lower.startsWith(".env.");
}

function isBlockedRel(posix: string): boolean {
  return isEngineProtectedPath(posix) || posix.split("/").some((part) => isBlockedName(part));
}

const JAIL_HOME_REL = ".legion-cli/sandbox-home";
const JAIL_TMP_REL = ".legion-cli/sandbox-tmp";
const JAIL_IDENTITY_REL = ".legion-cli/sandbox-identity";

const AUTH_HOME_RELS = [
  ".codex",
  ".claude",
  ".claude.json",
  ".config/claude",
  ".config/codex",
  ".local/share/claude",
] as const;

function isJailMeta(rel: string): boolean {
  return (
    rel === JAIL_HOME_REL ||
    rel.startsWith(`${JAIL_HOME_REL}/`) ||
    rel === JAIL_TMP_REL ||
    rel.startsWith(`${JAIL_TMP_REL}/`) ||
    rel === JAIL_IDENTITY_REL ||
    rel === ".git-null" ||
    rel.startsWith(".git-null/") ||
    rel === "node_modules" ||
    rel.startsWith("node_modules/")
  );
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]+")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}(?:/.*)?$`);
}

function matchesAllowed(posix: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => {
    if (entry.includes("*")) return globToRegExp(entry).test(posix);
    return posix === entry || posix.startsWith(`${entry}/`);
  });
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

function buildSandboxEnv(
  jailRoot: string,
  credentialKeys: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
  jailHome = join(jailRoot, ...JAIL_HOME_REL.split("/")),
  jailTmp = join(jailRoot, ...JAIL_TMP_REL.split("/")),
): NodeJS.ProcessEnv {
  const home = jailHome;
  const tmp = jailTmp;
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
  const allowedCreds = new Set(credentialKeys);
  for (const key of ADAPTER_CREDENTIAL_KEYS) {
    if (!allowedCreds.has(key)) continue;
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function selectJailBackend(requested: SandboxPolicy["backend"]): { want: SandboxBackend; hardened: boolean } {
  const detected = detectSandbox();
  const req = requested ?? "auto";
  if (req === "copy") return { want: "copy", hardened: false };
  if (req === "auto") return { want: detected.backend, hardened: detected.hardened };
  if (detected.backend === req && detected.hardened) return { want: req, hardened: true };
  return { want: "copy", hardened: false };
}

function assertJailRealpath(projectRoot: string, jailRoot: string): void {
  const projectReal = tryRealpath(projectRoot) ?? resolve(projectRoot);
  const expected = resolve(projectReal, ".legion-cli", "sandbox");
  const jailReal = tryRealpath(jailRoot);
  if (!jailReal || lexicalRel(expected, jailReal) === undefined) {
    throw new PathEscapeError(jailRoot);
  }
}

async function hashJailFiles(jailRoot: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rel of await listJailFiles(jailRoot)) {
    let src: string;
    try {
      src = toFsPath(jailRoot, rel);
    } catch {
      continue;
    }
    const hash = await fileSha256(src);
    if (hash) out.set(rel, hash);
  }
  return out;
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

function bwrapArgvPrefix(opts: {
  jailRoot: string;
  projectRoot: string;
  bindPaths: readonly string[];
  jailHome: string;
  authBinds: ReadonlyArray<{ src: string; dest: string }>;
}): string[] {
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
  for (const bind of opts.authBinds) roBind(bind.src, bind.dest);
  args.push("--setenv", "HOME", opts.jailHome);
  args.push("--chdir", opts.jailRoot, "--");
  return args;
}

/**
 * Execute-jail seatbelt profile: read/write only the jail, read the adapter binaries and auth sources, plus the
 * macOS runtime. Every path is emitted in the canonical spelling the kernel matches (macOS /var → /private/var).
 */
export function jailSeatbeltProfile(jailRoot: string, readPaths: readonly string[] = []): string {
  const jailReal = canonicalPathSync(jailRoot);
  const jail = JSON.stringify(jailReal);
  const reads = [jailReal, ...[...SYSTEM_RO_BINDS, ...readPaths].filter((path) => existsSync(path)).map(canonicalPathSync)];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    ...SEATBELT_DARWIN_RUNTIME_RULES,
    "(allow network*)",
    seatbeltAncestorMetadataRule([jailRoot, ...reads]),
    `(allow file-read* ${seatbeltSubpaths(reads)})`,
    `(allow file-write* (subpath ${jail}))`,
    `(allow file-ioctl (subpath ${jail}))`,
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
  try {
    await assertAgentPathAllowed(projectRoot, toProjectRelativePosix(projectRoot, src));
  } catch (err) {
    if (err instanceof PathEscapeError) return;
    throw err;
  }
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

async function copyAuthPath(
  src: string,
  dest: string,
  depth = 0,
  remaining = { files: 64 },
): Promise<void> {
  if (depth > 4 || remaining.files <= 0) return;
  let st;
  try {
    st = await lstat(src);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isFile()) {
    if (st.size > 2 * 1024 * 1024) return;
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    remaining.files -= 1;
    return;
  }
  if (!st.isDirectory()) return;
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (remaining.files <= 0) return;
    if (entry.isSymbolicLink()) continue;
    await copyAuthPath(join(src, entry.name), join(dest, entry.name), depth + 1, remaining);
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
  await assertAgentControlPathAllowed(projectRoot, posix);
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
      if ((err as NodeJS.ErrnoException).code === "ENOTDIR") return true;
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
  try {
    const st = await lstat(parent);
    if (st.isSymbolicLink() || !st.isDirectory()) return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") return true;
    if (code !== "ENOENT") throw err;
  }
  return pathHasSymlinkAncestor(parent, projectRoot);
}

async function safeCopyOutFile(src: string, dest: string, projectRoot: string): Promise<boolean> {
  return safeWriteOutFile(await readFile(src), dest, projectRoot);
}

async function safeWriteOutFile(
  contents: Buffer,
  dest: string,
  projectRoot: string,
  expectedDestHash?: string | null,
): Promise<boolean> {
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
    await writeFile(tmp, contents);
    try {
      const destSt = await lstat(dest);
      if (destSt.isSymbolicLink()) {
        await rm(tmp, { force: true });
        return false;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (expectedDestHash !== undefined && ((await fileSha256(dest)) ?? null) !== expectedDestHash) {
      await rm(tmp, { force: true });
      return false;
    }
    await rename(tmp, dest);
    return true;
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function listHostFilesUnder(projectRoot: string, allowedDir: string): Promise<string[]> {
  const out: string[] = [];
  let start: string;
  try {
    start = toFsPath(projectRoot, allowedDir);
  } catch {
    return out;
  }
  let startSt;
  try {
    startSt = await lstat(start);
  } catch {
    return out;
  }
  if (startSt.isSymbolicLink() || !startSt.isDirectory()) return out;
  if (await destIsUnsafe(projectRoot, start)) return out;

  const stack: { abs: string; rel: string; depth: number }[] = [
    { abs: start, rel: allowedDir, depth: 0 },
  ];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    if (cur.depth > MAX_COPY_DEPTH) continue;
    let entries;
    try {
      entries = await readdir(cur.abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      const abs = join(cur.abs, entry.name);
      const rel = `${cur.rel}/${entry.name}`;
      if (isBlockedRel(rel) || !isConcretePosixRepoRelativePath(rel)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push({ abs, rel, depth: cur.depth + 1 });
        continue;
      }
      if (entry.isFile()) out.push(rel);
    }
  }
  return out;
}

async function unlinkAllowedIfGone(
  projectRoot: string,
  rel: string,
  copied: string[],
): Promise<boolean> {
  if (isBlockedRel(rel) || !isConcretePosixRepoRelativePath(rel)) return false;
  let dest: string;
  try {
    dest = toFsPath(projectRoot, rel);
  } catch {
    return false;
  }
  try {
    const destSt = await lstat(dest);
    if (!destSt.isFile() || destSt.isSymbolicLink()) return false;
    if (await destIsUnsafe(projectRoot, dest)) return false;
    await rm(dest, { force: true });
    copied.push(rel);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return false;
  }
}

async function fileSha256(abs: string): Promise<string | undefined> {
  try {
    const st = await lstat(abs);
    if (!st.isFile() || st.isSymbolicLink()) return undefined;
    return createHash("sha256").update(await readFile(abs)).digest("hex");
  } catch {
    return undefined;
  }
}

function bytesSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function inspectOutputWrites(
  jailRoot: string,
  allowedWrites: readonly string[],
  copyInHashes: ReadonlyMap<string, string>,
): Promise<SandboxOutput> {
  const changes: SandboxOutputChange[] = [];
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
    const before = copyInHashes.get(rel);
    const after = await fileSha256(src);
    if (before !== undefined && after === before) continue;
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
    if (!after) {
      dropped.push(rel);
      continue;
    }
    changes.push({
      path: rel,
      action: "write",
      beforeHash: before ?? null,
      afterHash: after,
      content: await readFile(src),
    });
  }
  const jailSet = new Set(files);
  for (const [rel, beforeHash] of [...copyInHashes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (jailSet.has(rel) || isBlockedRel(rel) || !matchesAllowed(rel, allowedWrites)) continue;
    changes.push({ path: rel, action: "delete", beforeHash });
  }
  return { jailRoot, changes, dropped: [...new Set(dropped)].sort() };
}

async function applyOutputWrites(
  projectRoot: string,
  jailRoot: string,
  allowedWrites: readonly string[],
  output: SandboxOutput,
): Promise<SandboxApplyResult> {
  if (!samePath(output.jailRoot, jailRoot)) {
    throw new SandboxError("sandbox output belongs to a different jail");
  }
  const copied: string[] = [];
  const dropped = [...output.dropped];
  const conflicts: string[] = [];
  const seen = new Set<string>();
  const plan: Array<{ change: SandboxOutputChange; dest: string; before: Buffer | null }> = [];
  for (const change of output.changes) {
    const rel = change.path;
    if (
      seen.has(rel) ||
      !isConcretePosixRepoRelativePath(rel) ||
      isBlockedRel(rel) ||
      !matchesAllowed(rel, allowedWrites) ||
      (change.action !== "write" && change.action !== "delete") ||
      (change.beforeHash !== null && !/^[a-f0-9]{64}$/.test(change.beforeHash))
    ) {
      dropped.push(rel);
      continue;
    }
    seen.add(rel);
    let dest: string;
    try {
      await assertAgentPathAllowed(projectRoot, rel);
      dest = toFsPath(projectRoot, rel);
    } catch {
      dropped.push(rel);
      continue;
    }
    if ((await destIsUnsafe(projectRoot, dest)) || (await parentIsUnsafe(projectRoot, dirname(dest)))) {
      dropped.push(rel);
      continue;
    }
    const current = (await fileSha256(dest)) ?? null;
    if (current !== change.beforeHash) {
      conflicts.push(rel);
      continue;
    }
    let before: Buffer | null = null;
    try {
      const st = await lstat(dest);
      if (!st.isFile() || st.isSymbolicLink()) {
        dropped.push(rel);
        continue;
      }
      before = await readFile(dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (change.action === "delete") {
      plan.push({ change, dest, before });
      continue;
    }
    if (!change.afterHash || !change.content || bytesSha256(change.content) !== change.afterHash) {
      dropped.push(rel);
      continue;
    }
    plan.push({ change, dest, before });
  }
  if (dropped.length > output.dropped.length || conflicts.length > 0) {
    return {
      copied: [],
      dropped: [...new Set(dropped)].sort(),
      conflicts: [...new Set(conflicts)].sort(),
    };
  }
  const applied: typeof plan = [];
  try {
    for (const item of plan) {
      if (item.change.action === "delete") {
        if (((await fileSha256(item.dest)) ?? null) !== item.change.beforeHash) {
          throw new SandboxError(`sandbox output destination changed during application ${item.change.path}`);
        }
        if (item.before !== null) await rm(item.dest, { force: true });
      } else if (
        !item.change.content ||
        !(await safeWriteOutFile(item.change.content, item.dest, projectRoot, item.change.beforeHash))
      ) {
        throw new SandboxError(`sandbox output application refused ${item.change.path}`);
      }
      applied.push(item);
      copied.push(item.change.path);
    }
  } catch (err) {
    for (const item of [...applied].reverse()) {
      const appliedHash = item.change.action === "write" ? item.change.afterHash ?? null : null;
      if (((await fileSha256(item.dest)) ?? null) !== appliedHash) continue;
      if (item.before === null) await rm(item.dest, { force: true }).catch(() => undefined);
      else await safeWriteOutFile(item.before, item.dest, projectRoot, appliedHash).catch(() => false);
    }
    throw err;
  }
  return {
    copied,
    dropped: [...new Set(dropped)].sort(),
    conflicts: [...new Set(conflicts)].sort(),
  };
}

function sandboxHandle(input: {
  projectRoot: string;
  jailRoot: string;
  allowedWrites: string[];
  copyInHashes: ReadonlyMap<string, string>;
  backend: SandboxBackend;
  hardened: boolean;
  env: NodeJS.ProcessEnv;
  wrapper?: { bin: string; argvPrefix: string[] };
  destroyCreated: () => Promise<void>;
  identity: string;
}): SandboxHandle {
  const inspectedOutputs = new WeakSet<SandboxOutput>();
  const inspectOutput = async (): Promise<SandboxOutput> => {
    const raw = await inspectOutputWrites(input.jailRoot, input.allowedWrites, input.copyInHashes);
    for (const change of raw.changes) Object.freeze(change);
    Object.freeze(raw.changes);
    Object.freeze(raw.dropped);
    Object.freeze(raw);
    inspectedOutputs.add(raw);
    return raw;
  };
  const applyOutput = async (output: SandboxOutput): Promise<SandboxApplyResult> => {
    if (!inspectedOutputs.has(output)) {
      throw new SandboxError("sandbox output was not produced by this jail inspection");
    }
    inspectedOutputs.delete(output);
    return applyOutputWrites(input.projectRoot, input.jailRoot, input.allowedWrites, output);
  };
  return {
    backend: input.backend,
    hardened: input.hardened,
    jailRoot: input.jailRoot,
    identity: input.identity,
    spawnOpts() {
      const next: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        wrapper?: { bin: string; argvPrefix: string[] };
        translateInvoke: (invoke: string) => string;
      } = {
        cwd: input.jailRoot,
        env: { ...input.env },
        translateInvoke: (invoke: string) =>
          input.backend === "docker" ? translateHostPathToDocker(invoke, input.jailRoot) : invoke,
      };
      if (input.wrapper) next.wrapper = { bin: input.wrapper.bin, argvPrefix: [...input.wrapper.argvPrefix] };
      return next;
    },
    copyOut() {
      return inspectOutput().then(async (output) => {
        const applied = await applyOutput(output);
        return { copied: applied.copied, dropped: [...applied.dropped, ...applied.conflicts] };
      });
    },
    inspectOutput,
    applyOutput,
    destroy: input.destroyCreated,
  };
}

export async function materializeJail(policy: SandboxPolicy): Promise<SandboxHandle> {
  const projectRoot = resolve(policy.projectRoot);
  const runId = assertSafeRunId(policy.runId);
  const allowedWrites = unique(policy.allowedWrites.map(assertPolicyPath));
  const readSet = unique(policy.readSet.map(assertPolicyPath));
  for (const path of [...readSet, ...allowedWrites]) {
    const parts = path.split("/");
    const wildcard = parts.findIndex((part) => part.includes("*"));
    const concrete = (wildcard < 0 ? parts : parts.slice(0, wildcard)).join("/");
    await assertAgentControlPathAllowed(projectRoot, concrete);
  }

  const jailRoot = toFsPath(projectRoot, `.legion-cli/sandbox/${runId}`);
  const sandboxDir = legionPaths(projectRoot).sandboxDir;
  if (await pathHasSymlinkAncestor(sandboxDir, projectRoot)) {
    throw new PathEscapeError(jailRoot);
  }
  try {
    const leftover = await lstat(jailRoot);
    if (leftover.isSymbolicLink()) {
      throw new PathEscapeError(jailRoot);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const extraFiles: string[] = [];
  const destroyCreated = async () => {
    await rm(jailRoot, { recursive: true, force: true });
    for (const file of extraFiles) await rm(file, { force: true });
  };

  try {
    await rm(jailRoot, { recursive: true, force: true });
    await mkdir(jailRoot, { recursive: true });
    assertJailRealpath(projectRoot, jailRoot);
    const jailHome = join(jailRoot, ...JAIL_HOME_REL.split("/"));
    const jailTmp = join(jailRoot, ...JAIL_TMP_REL.split("/"));
    await mkdir(jailHome, { recursive: true });
    await mkdir(jailTmp, { recursive: true });
    await mkdir(join(jailRoot, ".git-null"), { recursive: true });

    for (const posix of readSet) {
      await copySparsePath(projectRoot, jailRoot, posix, false);
    }
    for (const posix of allowedWrites) {
      if (posix.includes("*")) continue;
      await copySparsePath(projectRoot, jailRoot, posix, true);
    }

    const authBinds: Array<{ src: string; dest: string }> = [];
    for (const hostHome of homeRealpaths()) {
      for (const rel of AUTH_HOME_RELS) {
        const src = join(hostHome, rel);
        if (!existsSync(src)) continue;
        const dest = join(jailHome, rel);
        await mkdir(dirname(dest), { recursive: true });
        authBinds.push({ src, dest });
      }
    }

    const selected = selectJailBackend(policy.backend);
    const binds = realpathsToBind(policy.adapterBinary);
    const env = buildSandboxEnv(jailRoot, policy.credentialKeys ?? [], process.env, jailHome, jailTmp);
    let wrapper: { bin: string; argvPrefix: string[] } | undefined;
    let backend: SandboxBackend = "copy";
    let hardened = false;

    const useCopy = selected.want === "copy" || !selected.hardened || !binds.ok;
    if (useCopy) {
      if (selected.want !== "copy" && selected.hardened && !policy.allowDegradedCopy) {
        throw new SandboxError(HARDENED_REQUIRED);
      }
      backend = "copy";
      hardened = false;
      for (const bind of authBinds) {
        await copyAuthPath(bind.src, bind.dest);
      }
    } else if (selected.want === "bwrap") {
      const bin = findRunnableBwrap();
      if (!bin) {
        if (!policy.allowDegradedCopy) throw new SandboxError(HARDENED_REQUIRED);
      } else {
        wrapper = {
          bin,
          argvPrefix: bwrapArgvPrefix({
            jailRoot,
            projectRoot,
            bindPaths: binds.paths,
            jailHome,
            authBinds,
          }),
        };
        backend = "bwrap";
        hardened = true;
      }
    } else if (selected.want === "docker") {
      const bin = findRunnableDocker();
      if (!bin) {
        if (!policy.allowDegradedCopy) throw new SandboxError(HARDENED_REQUIRED);
      } else {
        wrapper = {
          bin,
          argvPrefix: dockerArgvPrefix({ jailRoot }),
        };
        backend = "docker";
        hardened = true;
      }
    } else {
      const bin = findOnPath("sandbox-exec", true);
      if (!bin) {
        if (!policy.allowDegradedCopy) throw new SandboxError(HARDENED_REQUIRED);
      } else {
        const profilePath = join(legionPaths(projectRoot).sandboxDir, `${runId}.sb`);
        await mkdir(dirname(profilePath), { recursive: true });
        try {
          const st = await lstat(profilePath);
          if (st.isSymbolicLink() || !st.isFile()) {
            throw new SandboxError("sandbox profile path is unsafe");
          }
          await rm(profilePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        // Mirrors the bwrap binds: adapter binaries, their non-sensitive directories, and auth sources.
        const readPaths = [
          ...binds.paths,
          ...binds.paths.map((path) => dirname(path)).filter((dir) => !isUnsafeDirname(dir, projectRoot)),
          ...authBinds.map((bind) => bind.src),
        ];
        await writeFile(profilePath, jailSeatbeltProfile(jailRoot, readPaths), {
          encoding: "utf8",
          flag: "wx",
        });
        extraFiles.push(profilePath);
        wrapper = { bin, argvPrefix: ["-f", profilePath, "--"] };
        backend = "seatbelt";
        hardened = true;
      }
    }

    const nonce = randomBytes(32).toString("hex");
    const sentinelPath = toFsPath(jailRoot, JAIL_IDENTITY_REL);
    await mkdir(dirname(sentinelPath), { recursive: true });
    await writeFile(
      sentinelPath,
      `${JSON.stringify({ version: 1, runId, nonce })}\n`,
      { encoding: "utf8", flag: "wx" },
    );

    // Jail metadata is excluded from output inspection; extras suppression still needs source hashes.
    const copyInHashes = await hashJailFiles(jailRoot);
    const resume: SandboxResumeRecord = {
      version: 2,
      runId,
      nonce,
      backend,
      hardened,
      allowedWrites,
      copyInHashes: [...copyInHashes.entries()].sort(([a], [b]) => a.localeCompare(b)),
    };
    const resumePath = sandboxResumePath(projectRoot, runId);
    await mkdir(dirname(resumePath), { recursive: true });
    await writeFile(resumePath, `${JSON.stringify(resume, null, 2)}\n`, "utf8");
    const identity = sandboxIdentity(resume);

    return sandboxHandle({
      projectRoot,
      jailRoot,
      allowedWrites,
      copyInHashes,
      backend,
      hardened,
      env,
      ...(wrapper ? { wrapper } : {}),
      destroyCreated,
      identity,
    });
  } catch (err) {
    await destroyCreated();
    throw err;
  }
}

/** Reopens the exact retained jail and its immutable copy-in baseline for HTTP checkpoint recovery. */
export async function reopenJail(policy: SandboxPolicy): Promise<SandboxHandle> {
  const projectRoot = resolve(policy.projectRoot);
  const runId = assertSafeRunId(policy.runId);
  const allowedWrites = unique(policy.allowedWrites.map(assertPolicyPath));
  const readSet = unique(policy.readSet.map(assertPolicyPath));
  for (const path of [...readSet, ...allowedWrites]) {
    const parts = path.split("/");
    const wildcard = parts.findIndex((part) => part.includes("*"));
    const concrete = (wildcard < 0 ? parts : parts.slice(0, wildcard)).join("/");
    await assertAgentControlPathAllowed(projectRoot, concrete);
  }
  let record: SandboxResumeRecord;
  try {
    record = JSON.parse(await readFile(sandboxResumePath(projectRoot, runId), "utf8")) as SandboxResumeRecord;
  } catch (err) {
    throw new SandboxError(`sandbox recovery metadata is unavailable for ${runId}`, { cause: err });
  }
  if (
    record.version !== 2 ||
    record.runId !== runId ||
    typeof record.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.nonce) ||
    !["bwrap", "seatbelt", "copy", "docker"].includes(record.backend) ||
    typeof record.hardened !== "boolean" ||
    !Array.isArray(record.allowedWrites) ||
    JSON.stringify(record.allowedWrites) !== JSON.stringify(allowedWrites) ||
    !Array.isArray(record.copyInHashes)
  ) {
    throw new SandboxError("sandbox recovery metadata is incompatible");
  }
  const identity = sandboxIdentity(record);
  if (policy.expectedIdentity && policy.expectedIdentity !== identity) {
    throw new SandboxError("sandbox recovery identity changed");
  }
  if (policy.backend && policy.backend !== "auto" && policy.backend !== record.backend) {
    throw new SandboxError(`sandbox backend changed from ${record.backend} to ${policy.backend}`);
  }
  const copyInHashes = new Map<string, string>();
  for (const entry of record.copyInHashes) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !/^[a-f0-9]{64}$/.test(entry[1])) {
      throw new SandboxError("sandbox recovery baseline is malformed");
    }
    copyInHashes.set(assertPolicyPath(entry[0]), entry[1]);
  }
  const jailRoot = toFsPath(projectRoot, `.legion-cli/sandbox/${runId}`);
  assertJailRealpath(projectRoot, jailRoot);
  await assertJailIdentitySentinel(projectRoot, runId, record.nonce);
  const jailHome = join(jailRoot, ...JAIL_HOME_REL.split("/"));
  const jailTmp = join(jailRoot, ...JAIL_TMP_REL.split("/"));
  const authBinds: Array<{ src: string; dest: string }> = [];
  for (const hostHome of homeRealpaths()) {
    for (const rel of AUTH_HOME_RELS) {
      const src = join(hostHome, rel);
      if (existsSync(src)) authBinds.push({ src, dest: join(jailHome, rel) });
    }
  }
  const binds = realpathsToBind(policy.adapterBinary);
  if (record.hardened && !binds.ok) throw new SandboxError("sandbox recovery adapter binary is unavailable");
  const env = buildSandboxEnv(jailRoot, policy.credentialKeys ?? [], process.env, jailHome, jailTmp);
  let wrapper: { bin: string; argvPrefix: string[] } | undefined;
  const extraFiles: string[] = [];
  if (record.backend === "bwrap") {
    const bin = findRunnableBwrap();
    if (!bin) throw new SandboxError("retained bwrap jail cannot be reopened");
    wrapper = { bin, argvPrefix: bwrapArgvPrefix({ jailRoot, projectRoot, bindPaths: binds.ok ? binds.paths : [], jailHome, authBinds }) };
  } else if (record.backend === "docker") {
    const bin = findRunnableDocker();
    if (!bin) throw new SandboxError("retained Docker jail cannot be reopened");
    wrapper = { bin, argvPrefix: dockerArgvPrefix({ jailRoot }) };
  } else if (record.backend === "seatbelt") {
    const bin = findOnPath("sandbox-exec", true);
    const profilePath = join(legionPaths(projectRoot).sandboxDir, `${runId}.sb`);
    if (!bin || !existsSync(profilePath)) throw new SandboxError("retained seatbelt jail cannot be reopened");
    wrapper = { bin, argvPrefix: ["-f", profilePath, "--"] };
    extraFiles.push(profilePath);
  }
  const destroyCreated = async () => {
    await rm(jailRoot, { recursive: true, force: true });
    for (const file of extraFiles) await rm(file, { force: true });
  };
  return sandboxHandle({
    projectRoot,
    jailRoot,
    allowedWrites,
    copyInHashes,
    backend: record.backend,
    hardened: record.hardened,
    env,
    ...(wrapper ? { wrapper } : {}),
    destroyCreated,
    identity,
  });
}

/** Reads and validates the immutable retained-jail identity without reopening it. */
export async function retainedJailIdentity(projectRoot: string, rawRunId: string): Promise<string> {
  projectRoot = resolve(projectRoot);
  const runId = assertSafeRunId(rawRunId);
  let record: SandboxResumeRecord;
  try {
    record = JSON.parse(await readFile(sandboxResumePath(projectRoot, runId), "utf8")) as SandboxResumeRecord;
  } catch (err) {
    throw new SandboxError(`sandbox recovery metadata is unavailable for ${runId}`, { cause: err });
  }
  if (
    record.version !== 2 ||
    record.runId !== runId ||
    typeof record.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.nonce) ||
    !["bwrap", "seatbelt", "copy", "docker"].includes(record.backend) ||
    typeof record.hardened !== "boolean" ||
    !Array.isArray(record.allowedWrites) ||
    !Array.isArray(record.copyInHashes)
  ) throw new SandboxError("sandbox recovery metadata is incompatible");
  await assertJailIdentitySentinel(projectRoot, runId, record.nonce);
  return sandboxIdentity(record);
}
