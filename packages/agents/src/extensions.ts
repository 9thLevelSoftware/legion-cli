import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  assertResolvedInside,
  fetchGithubZipball,
  hashTreeFiles,
  legionPaths,
  parseGithubRepoSource,
  PathEscapeError,
  readNinthlevelMinisignPub,
  SsrfError,
  toPosixPath,
  unzipZipball,
  verifyMinisign,
  type SsrfLookup,
} from "@9thlevelsoftware/legion-cli-persist";
import { SkillIdSchema } from "@9thlevelsoftware/legion-cli-schema";
import { AgentError } from "./errors.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const EXTENSION_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_RESOURCE_RE = /^(?:scripts|references|assets)\/[A-Za-z0-9._/-]+$/;
const RUN_WRITE_ROOT = ".legion-cli/extensions/runs/**";
const PIN_FILE = "extension.json";
const HASH_FILE = "sha256.hex";
const SIG_FILE = "sha256.hex.minisig";

export type ExtensionPermissions = {
  read: string[];
  write: string[];
  commands: string[];
};

export type ExtensionManifest = {
  ref: `extension:${string}`;
  extensionId: string;
  name: string;
  description: string;
  compatibility: string;
  version: string;
  allowedTools: string[];
  requiredTools: string[];
  requiredChecks: string[];
  resources: string[];
  permissions: ExtensionPermissions;
  path: string;
  bodyChars: number;
};

export type ParsedExtension =
  | { ok: true; manifest: ExtensionManifest; body: string }
  | { ok: false; extensionIdGuess: string; path: string; reason: string };

export type ExtensionPin = {
  schemaVersion: "legion-cli-extension-pin/v1";
  extensionId: string;
  source: { type: "local" | "github"; origin: string; ref?: string };
  integrity: { sha256: string; minisign?: string };
  installedAt: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) return undefined;
  return value.map((entry) => String(entry).trim());
}

function extensionIdFromPath(path: string): string {
  const parts = toPosixPath(path).split("/").filter(Boolean);
  return parts.at(-2) ?? "";
}

function fail(path: string, extensionIdGuess: string, reason: string): ParsedExtension {
  return { ok: false, extensionIdGuess, path, reason };
}

function parseAllowedTools(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (Array.isArray(value)) return stringArray(value);
  if (typeof value !== "string") return undefined;
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function normalizedCommand(value: string): string | undefined {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.some((token) => !/^[A-Za-z0-9@._/+\-=]+$/.test(token))) return undefined;
  return tokens.join(" ");
}

function validReadRoot(value: string): boolean {
  const posix = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return Boolean(
    posix &&
    !/[?*\[]/.test(posix) &&
    !posix.startsWith("/") &&
    !/^[A-Za-z]:/.test(posix) &&
    !posix.split("/").includes("..") &&
    posix !== ".git" &&
    !posix.startsWith(".git/") &&
    posix !== ".env" &&
    !posix.startsWith(".env."),
  );
}

function validateAllowedTools(allowedTools: readonly string[], commands: readonly string[]): string | undefined {
  const bashCommands: string[] = [];
  for (const tool of allowedTools) {
    if (tool === "Read" || tool === "Write") continue;
    const match = /^Bash\((.+):\*\)$/.exec(tool);
    const command = match?.[1] ? normalizedCommand(match[1]) : undefined;
    if (!command) return `unsupported allowed-tools entry '${tool}'`;
    bashCommands.push(command);
  }
  const normalizedCommands = commands.map(normalizedCommand);
  if (normalizedCommands.some((command) => command === undefined)) {
    return "permissions.commands must contain plain argv prefixes without shell syntax";
  }
  const declared = [...new Set(bashCommands)].sort();
  const permitted = [...new Set(normalizedCommands as string[])].sort();
  if (declared.length !== permitted.length || declared.some((command, index) => command !== permitted[index])) {
    return "allowed-tools Bash prefixes must exactly match permissions.commands";
  }
  return undefined;
}

export function parseExtensionFrontmatter(raw: string, path: string): ParsedExtension {
  const extensionIdGuess = extensionIdFromPath(path);
  try {
    const match = FRONTMATTER_RE.exec(raw);
    if (!match) return fail(path, extensionIdGuess, "missing YAML frontmatter");
    const data = record(parseYaml(match[1] ?? ""));
    if (!data) return fail(path, extensionIdGuess, "frontmatter must be a YAML mapping");
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const description = typeof data.description === "string" ? data.description.trim() : "";
    const compatibility = typeof data.compatibility === "string" ? data.compatibility.trim() : undefined;
    const allowedTools = parseAllowedTools(data["allowed-tools"] ?? data.allowedTools);
    const legion = record(record(data.metadata)?.legion);
    const extensionId = typeof legion?.extensionId === "string" ? legion.extensionId.trim() : "";
    const version = typeof legion?.version === "string" ? legion.version.trim() : "";
    if (!EXTENSION_ID_RE.test(extensionId)) return fail(path, extensionIdGuess, "metadata.legion.extensionId is invalid");
    if ((SkillIdSchema.options as readonly string[]).includes(extensionId)) {
      return fail(path, extensionIdGuess, `${extensionId} is a core lifecycle skill and cannot be an extension`);
    }
    if (name !== extensionId || extensionIdGuess !== extensionId) {
      return fail(path, extensionIdGuess, `name, directory, and extensionId must all equal '${extensionId}'`);
    }
    if (!description) return fail(path, extensionIdGuess, "description is required");
    if (!compatibility) return fail(path, extensionIdGuess, "compatibility is required");
    if (!version) return fail(path, extensionIdGuess, "metadata.legion.version is required");
    if (!allowedTools) return fail(path, extensionIdGuess, "allowed-tools must be a string or string array");
    const requiredTools = stringArray(legion?.requiredTools);
    const requiredChecks = stringArray(legion?.checks);
    const resourcesRaw = record(legion?.resources);
    if (!requiredTools || !requiredChecks || requiredChecks.length === 0 || !resourcesRaw) {
      return fail(path, extensionIdGuess, "requiredTools, non-empty checks, and resources are required");
    }
    const resources = [
      ...(stringArray(resourcesRaw.scripts) ?? []),
      ...(stringArray(resourcesRaw.references) ?? []),
      ...(stringArray(resourcesRaw.assets) ?? []),
    ];
    if (resources.some((resource) => !SAFE_RESOURCE_RE.test(resource) || resource.includes(".."))) {
      return fail(path, extensionIdGuess, "resources must stay under scripts/, references/, or assets/");
    }
    const permissionsRaw = record(legion?.permissions);
    const read = stringArray(permissionsRaw?.read);
    const write = stringArray(permissionsRaw?.write);
    const commands = stringArray(permissionsRaw?.commands);
    if (!read || !write || !commands) return fail(path, extensionIdGuess, "permissions read/write/commands are required arrays");
    if (read.some((entry) => !validReadRoot(entry))) {
      return fail(path, extensionIdGuess, "permissions.read must contain explicit safe file or directory roots; globs are not supported");
    }
    const allowedToolsError = validateAllowedTools(allowedTools, commands);
    if (allowedToolsError) return fail(path, extensionIdGuess, allowedToolsError);
    if (write.some((entry) => entry !== RUN_WRITE_ROOT)) {
      return fail(path, extensionIdGuess, `extension write permissions must use the evidence run root ${RUN_WRITE_ROOT}`);
    }
    const body = raw.slice(match[0].length).replace(/^\r?\n/, "");
    return {
      ok: true,
      manifest: {
        ref: `extension:${extensionId}`,
        extensionId,
        name,
        description,
        compatibility,
        version,
        allowedTools,
        requiredTools,
        requiredChecks,
        resources,
        permissions: { read, write, commands },
        path,
        bodyChars: body.length,
      },
      body,
    };
  } catch (err) {
    return fail(path, extensionIdGuess, err instanceof Error ? err.message : String(err));
  }
}

function manifestPath(dir: string): string | undefined {
  for (const name of ["EXTENSION.md", "SKILL.md"]) {
    const path = join(dir, name);
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return undefined;
}

export async function validateExtensionResources(dir: string, manifest: ExtensionManifest): Promise<void> {
  for (const resource of manifest.resources) {
    const parts = resource.split("/");
    let current = resolve(dir);
    for (const part of parts) {
      current = assertResolvedInside(dir, join(current, part), resource);
      let stat;
      try {
        stat = await lstat(current);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new AgentError(`declared resource is missing: ${resource}`);
        }
        throw err;
      }
      if (stat.isSymbolicLink()) throw new AgentError(`declared resource must not use symlinks: ${resource}`);
    }
    const leaf = await lstat(current);
    if (!leaf.isFile()) throw new AgentError(`declared resource is not a regular file: ${resource}`);
  }
}

function containsExtension(dir: string): boolean {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory() && Boolean(manifestPath(join(dir, entry.name))));
}

export function findExtensionsDir(from = process.cwd()): string | undefined {
  const env = process.env.LEGION_CLI_EXTENSIONS_DIR?.trim();
  if (env) return env;
  const starts = [from];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // ignore
  }
  for (const start of starts) {
    let dir = resolve(start);
    for (let depth = 0; depth < 10; depth += 1) {
      if (basename(dir).toLowerCase() === "extensions" && containsExtension(dir)) return dir;
      const candidate = join(dir, "extensions");
      if (containsExtension(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

function overlayRoot(projectRoot: string): string {
  return join(legionPaths(projectRoot).root, "extensions");
}

export function extensionOverlayDir(projectRoot: string, extensionId: string): string {
  if (!EXTENSION_ID_RE.test(extensionId)) throw new AgentError(`invalid extension id '${extensionId}'`);
  return join(overlayRoot(projectRoot), extensionId);
}

async function treeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(rel ? join(dir, ...rel.split("/")) : dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new PathEscapeError(child);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name !== PIN_FILE && entry.name !== HASH_FILE && !entry.name.endsWith(".minisig")) out.push(child);
    }
  };
  await walk("");
  return out.sort();
}

export async function hashExtensionTree(dir: string): Promise<string> {
  return hashTreeFiles(dir, await treeFiles(dir));
}

async function readPin(path: string): Promise<ExtensionPin> {
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<ExtensionPin>;
  if (
    value.schemaVersion !== "legion-cli-extension-pin/v1" ||
    typeof value.extensionId !== "string" ||
    !value.source ||
    (value.source.type !== "local" && value.source.type !== "github") ||
    typeof value.source.origin !== "string" ||
    !value.integrity ||
    !/^[a-f0-9]{64}$/.test(value.integrity.sha256 ?? "") ||
    typeof value.installedAt !== "string"
  ) {
    throw new AgentError("extension.json is invalid");
  }
  return value as ExtensionPin;
}

export async function resolveExtensionDir(opts: {
  projectRoot: string;
  extensionId: string;
  packagedExtensionsDir?: string;
}): Promise<
  | { ok: true; extensionDir: string; source: "packaged" | "overlay"; pin?: ExtensionPin }
  | { ok: false; reason: string; pinned: boolean }
> {
  const overlay = extensionOverlayDir(opts.projectRoot, opts.extensionId);
  const pinPath = join(overlay, PIN_FILE);
  if (existsSync(pinPath)) {
    try {
      const pin = await readPin(pinPath);
      if (pin.extensionId !== opts.extensionId) return { ok: false, reason: "extension pin identity mismatch", pinned: true };
      if (!manifestPath(overlay)) return { ok: false, reason: "pinned extension is missing EXTENSION.md or SKILL.md", pinned: true };
      if ((await hashExtensionTree(overlay)) !== pin.integrity.sha256) return { ok: false, reason: "extension pin digest mismatch", pinned: true };
      const file = manifestPath(overlay);
      const parsed = file ? parseExtensionFrontmatter(await readFile(file, "utf8"), `.legion-cli/extensions/${opts.extensionId}/${basename(file)}`) : undefined;
      if (!parsed?.ok) return { ok: false, reason: parsed?.reason ?? "extension manifest is missing", pinned: true };
      await validateExtensionResources(overlay, parsed.manifest);
      return { ok: true, extensionDir: overlay, source: "overlay", pin };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err), pinned: true };
    }
  }
  const root = opts.packagedExtensionsDir ?? findExtensionsDir();
  const dir = root ? join(root, opts.extensionId) : undefined;
  if (!dir || !manifestPath(dir)) return { ok: false, reason: `extension:${opts.extensionId} is not installed`, pinned: false };
  try {
    const file = manifestPath(dir);
    const parsed = file ? parseExtensionFrontmatter(await readFile(file, "utf8"), `extensions/${opts.extensionId}/${basename(file)}`) : undefined;
    if (!parsed?.ok) return { ok: false, reason: parsed?.reason ?? "extension manifest is missing", pinned: false };
    await validateExtensionResources(dir, parsed.manifest);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), pinned: false };
  }
  return { ok: true, extensionDir: dir, source: "packaged" };
}

export async function listExtensionCatalog(opts: {
  projectRoot: string;
  packagedExtensionsDir?: string;
}): Promise<{ extensions: ExtensionManifest[]; skipped: Array<{ path: string; reason: string }> }> {
  const root = opts.packagedExtensionsDir ?? findExtensionsDir();
  const ids = new Set<string>();
  if (root && existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && EXTENSION_ID_RE.test(entry.name)) ids.add(entry.name);
  }
  const overlays = overlayRoot(opts.projectRoot);
  if (existsSync(overlays)) {
    for (const entry of readdirSync(overlays, { withFileTypes: true })) if (entry.isDirectory() && EXTENSION_ID_RE.test(entry.name)) ids.add(entry.name);
  }
  const extensions: ExtensionManifest[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const extensionId of [...ids].sort()) {
    const resolved = await resolveExtensionDir({ projectRoot: opts.projectRoot, extensionId, packagedExtensionsDir: root });
    if (!resolved.ok) {
      skipped.push({ path: `extension:${extensionId}`, reason: resolved.reason });
      continue;
    }
    const file = manifestPath(resolved.extensionDir);
    if (!file) continue;
    const rel = `${resolved.source === "overlay" ? ".legion-cli/extensions" : "extensions"}/${extensionId}/${basename(file)}`;
    const parsed = parseExtensionFrontmatter(await readFile(file, "utf8"), rel);
    if (!parsed.ok) {
      skipped.push({ path: rel, reason: parsed.reason });
      continue;
    }
    extensions.push(parsed.manifest);
  }
  return { extensions, skipped };
}

function isRemoteLooking(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|git@|\\\\|\/\/)/i.test(value) && !/^[A-Za-z]:[\\/]/.test(value);
}

async function copyTree(source: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if ([PIN_FILE, HASH_FILE, SIG_FILE].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new PathEscapeError(entry.name);
    await cp(join(source, entry.name), join(dest, entry.name), { recursive: true, dereference: true, force: true });
  }
}

function candidateDirs(root: string, wanted?: string): string[] {
  const candidates = new Set<string>();
  if (manifestPath(root)) candidates.add(root);
  const roots = [root, join(root, "extensions")];
  for (const parent of roots) {
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && (!wanted || entry.name === wanted) && manifestPath(join(parent, entry.name))) candidates.add(join(parent, entry.name));
    }
  }
  return [...candidates];
}

async function signatureFor(sourceDir: string, digest: string, trustKeys: readonly string[]): Promise<string | undefined> {
  const sigPath = join(sourceDir, SIG_FILE);
  if (!existsSync(sigPath)) return undefined;
  const declaredPath = join(sourceDir, HASH_FILE);
  const payload = existsSync(declaredPath) ? (await readFile(declaredPath, "utf8")).trim() : digest;
  const signature = await readFile(sigPath, "utf8");
  let last: unknown;
  for (const publicKey of [readNinthlevelMinisignPub(), ...trustKeys]) {
    try {
      await verifyMinisign({ payload, signature, publicKey });
      if (payload !== digest) throw new AgentError("extension integrity mismatch");
      return signature;
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new AgentError("extension minisign verification failed");
}

export async function installExtensionOverlay(opts: {
  projectRoot: string;
  source: string;
  extensionId?: string;
  unsigned?: boolean;
  integritySha256?: string;
  trustKeys?: readonly string[];
  cwd?: string;
  lookup?: SsrfLookup;
  fetchZip?: (source: string) => Promise<{ body: Buffer }>;
}): Promise<{ extensionId: string; dest: string; pin: ExtensionPin }> {
  const source = opts.source.trim();
  if (!source) throw new AgentError("extension install source is required");
  const remote = /^github:/i.test(source);
  if (remote && opts.unsigned) throw new AgentError("remote extension install cannot use --unsigned");
  let root: string;
  let sourceMeta: ExtensionPin["source"];
  let cleanup: string | undefined;
  if (remote) {
    const parsed = parseGithubRepoSource(source);
    if (parsed.owner.includes(".")) throw new SsrfError("fetch host is not allowlisted");
    if (!parsed.ref) throw new AgentError("github extension install requires @tag");
    const fetched = opts.fetchZip ? await opts.fetchZip(source) : await fetchGithubZipball(source, { lookup: opts.lookup });
    cleanup = join(opts.projectRoot, ".legion-cli", "cache", "extension-install", randomUUID());
    await unzipZipball(fetched.body, cleanup);
    root = cleanup;
    sourceMeta = { type: "github", origin: `${parsed.owner}/${parsed.repo}`, ref: parsed.ref };
  } else {
    if (isRemoteLooking(source)) throw new AgentError("extension install supports a local directory or github:owner/repo@tag");
    root = resolve(opts.cwd ?? process.cwd(), source);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new AgentError(`extension install path is not a local directory: ${source}`);
    sourceMeta = { type: "local", origin: root };
  }
  try {
    const candidates = candidateDirs(root, opts.extensionId);
    if (candidates.length !== 1) throw new AgentError(candidates.length === 0 ? "extension bundle contains no matching extension" : "extension bundle requires --extension <id>");
    const selected = candidates[0];
    if (!selected) throw new AgentError("extension bundle contains no matching extension");
    const file = manifestPath(selected);
    if (!file) throw new AgentError("extension manifest is missing");
    const parsed = parseExtensionFrontmatter(await readFile(file, "utf8"), `extensions/${basename(selected)}/${basename(file)}`);
    if (!parsed.ok) throw new AgentError(`extension frontmatter is invalid (${parsed.reason})`);
    await validateExtensionResources(selected, parsed.manifest);
    const digest = await hashExtensionTree(selected);
    if (opts.integritySha256 && digest !== opts.integritySha256) throw new AgentError("extension integrity mismatch");
    const signature = await signatureFor(selected, digest, opts.trustKeys ?? []);
    if (remote && !signature) throw new AgentError("remote extension install requires a minisign signature");
    if (!remote && !signature && !opts.unsigned) throw new AgentError("local extension install requires a minisign signature or --unsigned");
    const dest = extensionOverlayDir(opts.projectRoot, parsed.manifest.extensionId);
    assertResolvedInside(opts.projectRoot, dest, dest);
    let current = dest;
    while (resolve(current).startsWith(resolve(opts.projectRoot))) {
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new PathEscapeError(dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (resolve(current) === resolve(opts.projectRoot)) break;
      current = dirname(current);
    }
    const staging = join(opts.projectRoot, ".legion-cli", "cache", "extension-install", randomUUID());
    await copyTree(selected, staging);
    const stagedDigest = await hashExtensionTree(staging);
    if (stagedDigest !== digest) throw new AgentError("extension integrity mismatch after staging");
    const pin: ExtensionPin = {
      schemaVersion: "legion-cli-extension-pin/v1",
      extensionId: parsed.manifest.extensionId,
      source: sourceMeta,
      integrity: signature ? { sha256: digest, minisign: signature } : { sha256: digest },
      installedAt: new Date().toISOString(),
    };
    await writeFile(join(staging, PIN_FILE), `${JSON.stringify(pin, null, 2)}\n`, "utf8");
    await rm(dest, { recursive: true, force: true });
    await mkdir(dirname(dest), { recursive: true });
    await rename(staging, dest);
    return { extensionId: parsed.manifest.extensionId, dest, pin };
  } finally {
    if (cleanup) await rm(cleanup, { recursive: true, force: true });
  }
}
