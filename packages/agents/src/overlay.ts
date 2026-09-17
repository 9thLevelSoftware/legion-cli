import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  fetchGithubZipball,
  hashTreeFiles,
  legionPaths,
  MinisignError,
  parseGithubRepoSource,
  PathEscapeError,
  PersistError,
  readNinthlevelMinisignPub,
  SsrfError,
  toFsPath,
  toPosixPath,
  unzipZipball,
  verifyMinisign,
  type SsrfLookup,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  SCHEMA_VERSION,
  SkillIdSchema,
  SkillOverlayPinSchema,
  type SkillCatalog,
  type SkillCatalogEntry,
  type SkillId,
  type SkillOverlayPin,
} from "@9thlevelsoftware/legion-cli-schema";
import {
  findSkillsDir,
  isRequiredSkillId,
  listLevel3Resources,
  listSkillCatalog,
  parseSkillFrontmatter,
  skillCatalogPath,
} from "./catalog.js";
import { AgentError } from "./errors.js";

export const OVERLAY_PIN_FILENAME = "overlay.json";
const DECLARED_HASH_FILENAME = "sha256.hex";

const GITHUB_PREFIX = /^github:/i;
const WINDOWS_DRIVE = /^[a-zA-Z]:(?:[\\/]|$)/;
const UNC_OR_PROTOCOL_RELATIVE = /^(?:\/\/|\\\\)/;
const URL_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|git@)/i;

export type SkillDirSource = "overlay" | "packaged";

export type ResolvedSkillDir =
  | {
      ok: true;
      skillDir: string;
      source: SkillDirSource;
      pin?: SkillOverlayPin;
    }
  | {
      ok: false;
      reason: string;
      pinned: boolean;
      source: SkillDirSource | "missing";
    };

function isExcludedOverlayName(name: string): boolean {
  return name === OVERLAY_PIN_FILENAME || name === DECLARED_HASH_FILENAME || name.endsWith(".minisig");
}

export function overlaySkillDir(projectRoot: string, skillId: SkillId): string {
  return join(legionPaths(projectRoot).skillsOverlayDir, skillId);
}

/** Pin metadata is not skill protocol; hashing and staging omit it. */
export async function listSkillTreeFiles(skillDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel ? toFsPath(skillDir, rel) : skillDir;
    let ents;
    try {
      ents = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const ent of ents) {
      if (ent.name === "." || ent.name === "..") continue;
      if (isExcludedOverlayName(ent.name)) continue;
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) {
        throw new PathEscapeError(child);
      }
      if (ent.isDirectory()) await walk(child);
      else if (ent.isFile()) out.push(toPosixPath(child));
    }
  }
  await walk("");
  return out.sort();
}

export async function hashSkillTree(skillDir: string): Promise<string> {
  const files = await listSkillTreeFiles(skillDir);
  return hashTreeFiles(skillDir, files);
}

async function readOverlayPin(pinPath: string): Promise<
  { ok: true; pin: SkillOverlayPin } | { ok: false; reason: string }
> {
  let raw: string;
  try {
    raw = await readFile(pinPath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `overlay.json unreadable (${reason})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `overlay.json failed parse (${reason})` };
  }
  const parsed = SkillOverlayPinSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid overlay pin";
    return { ok: false, reason: `overlay.json failed parse (${detail})` };
  }
  return { ok: true, pin: parsed.data };
}

export async function resolveSkillDir(opts: {
  projectRoot: string;
  skillId: SkillId;
  packagedSkillsDir?: string;
}): Promise<ResolvedSkillDir> {
  const overlayDir = overlaySkillDir(opts.projectRoot, opts.skillId);
  const pinPath = join(overlayDir, OVERLAY_PIN_FILENAME);
  if (existsSync(pinPath)) {
    const pinRead = await readOverlayPin(pinPath);
    if (!pinRead.ok) {
      return { ok: false, reason: pinRead.reason, pinned: true, source: "overlay" };
    }
    if (pinRead.pin.skillId !== opts.skillId) {
      return {
        ok: false,
        reason: `overlay pin skillId "${pinRead.pin.skillId}" must equal directory "${opts.skillId}"`,
        pinned: true,
        source: "overlay",
      };
    }
    const skillMd = join(overlayDir, "SKILL.md");
    if (!existsSync(skillMd)) {
      return {
        ok: false,
        reason: `${opts.skillId} overlay is missing SKILL.md`,
        pinned: true,
        source: "overlay",
      };
    }
    let digest: string;
    try {
      digest = await hashSkillTree(overlayDir);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `overlay pin digest failed (${reason})`, pinned: true, source: "overlay" };
    }
    if (digest !== pinRead.pin.integrity.sha256) {
      return {
        ok: false,
        reason: `overlay pin digest mismatch for ${opts.skillId}`,
        pinned: true,
        source: "overlay",
      };
    }
    return { ok: true, skillDir: overlayDir, source: "overlay", pin: pinRead.pin };
  }

  const packagedDir = opts.packagedSkillsDir ?? findSkillsDir();
  const packagedSkillDir = packagedDir ? join(packagedDir, opts.skillId) : undefined;
  const packagedMd = packagedSkillDir ? join(packagedSkillDir, "SKILL.md") : undefined;
  if (!packagedDir || !packagedSkillDir || !packagedMd || !existsSync(packagedMd)) {
    return {
      ok: false,
      reason: `${opts.skillId} requires skills/${opts.skillId}/SKILL.md`,
      pinned: false,
      source: "missing",
    };
  }
  return { ok: true, skillDir: packagedSkillDir, source: "packaged" };
}

export async function listResolvedSkillCatalog(opts: {
  projectRoot: string;
  packagedSkillsDir?: string;
}): Promise<{
  catalog: SkillCatalog;
  skipped: Array<{ path: string; reason: string; required: boolean }>;
  overlays: Array<{ skillId: SkillId; pin: SkillOverlayPin; digestOk: boolean }>;
}> {
  const packagedDir = opts.packagedSkillsDir ?? findSkillsDir();
  const base = packagedDir
    ? listSkillCatalog(packagedDir)
    : {
        catalog: { schemaVersion: SCHEMA_VERSION.skillCatalog, skills: [] as SkillCatalogEntry[] },
        skipped: SkillIdSchema.options.map((skillId) => ({
          path: skillCatalogPath(skillId),
          reason: "skills dir not found",
          required: isRequiredSkillId(skillId),
        })),
      };
  const skills = new Map(base.catalog.skills.map((skill) => [skill.skillId, skill] as const));
  const skippedByPath = new Map(base.skipped.map((row) => [row.path, row] as const));
  const overlays: Array<{ skillId: SkillId; pin: SkillOverlayPin; digestOk: boolean }> = [];

  const dropPackagedSkip = (skillId: SkillId): void => {
    skippedByPath.delete(skillCatalogPath(skillId));
    skippedByPath.delete(skillCatalogPath(skillId, "overlay"));
  };

  for (const skillId of SkillIdSchema.options) {
    const resolved = await resolveSkillDir({
      projectRoot: opts.projectRoot,
      skillId,
      packagedSkillsDir: packagedDir,
    });
    if (resolved.ok && resolved.source === "packaged") continue;
    if (resolved.ok && resolved.source === "overlay") {
      const catalogPath = skillCatalogPath(skillId, "overlay");
      let raw: string;
      try {
        raw = await readFile(join(resolved.skillDir, "SKILL.md"), "utf8");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        skills.delete(skillId);
        dropPackagedSkip(skillId);
        skippedByPath.set(catalogPath, { path: catalogPath, reason, required: isRequiredSkillId(skillId) });
        if (resolved.pin) overlays.push({ skillId, pin: resolved.pin, digestOk: true });
        continue;
      }
      const parsed = parseSkillFrontmatter(raw, catalogPath);
      dropPackagedSkip(skillId);
      if (!parsed.ok) {
        skills.delete(skillId);
        skippedByPath.set(parsed.path, {
          path: parsed.path,
          reason: parsed.reason,
          required: isRequiredSkillId(skillId),
        });
        if (resolved.pin) overlays.push({ skillId, pin: resolved.pin, digestOk: true });
        continue;
      }
      const resources = listLevel3Resources(resolved.skillDir);
      skills.set(skillId, { ...parsed.entry, resources, path: catalogPath });
      if (resolved.pin) overlays.push({ skillId, pin: resolved.pin, digestOk: true });
      continue;
    }
    if (!resolved.ok && resolved.pinned) {
      skills.delete(skillId);
      const catalogPath = skillCatalogPath(skillId, "overlay");
      dropPackagedSkip(skillId);
      skippedByPath.set(catalogPath, {
        path: catalogPath,
        reason: resolved.reason,
        required: isRequiredSkillId(skillId),
      });
    }
  }
  const skipped = [...skippedByPath.values()];

  return {
    catalog: {
      schemaVersion: SCHEMA_VERSION.skillCatalog,
      skills: SkillIdSchema.options.flatMap((id) => {
        const entry = skills.get(id);
        return entry ? [entry] : [];
      }),
    },
    skipped,
    overlays,
  };
}

function isRemoteLooking(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed || WINDOWS_DRIVE.test(trimmed)) return false;
  if (GITHUB_PREFIX.test(trimmed)) return true;
  if (UNC_OR_PROTOCOL_RELATIVE.test(trimmed)) return true;
  if (URL_SCHEME.test(trimmed)) return true;
  return false;
}

function ownerLooksLikeHost(owner: string): boolean {
  return owner.includes(".");
}

async function listMinisigFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel ? toFsPath(dir, rel) : dir;
    let ents;
    try {
      ents = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const ent of ents) {
      if (ent.name === "." || ent.name === "..") continue;
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) throw new PathEscapeError(child);
      if (ent.isDirectory()) await walk(child);
      else if (ent.isFile() && ent.name.endsWith(".minisig")) out.push(toPosixPath(child));
    }
  }
  await walk("");
  return out.sort();
}

async function verifyOverlaySignature(opts: {
  payload: string;
  signature: string;
  trustKeys: readonly string[];
}): Promise<void> {
  const keys = [readNinthlevelMinisignPub(), ...opts.trustKeys];
  let last: unknown;
  for (const publicKey of keys) {
    try {
      await verifyMinisign({ payload: opts.payload, signature: opts.signature, publicKey });
      return;
    } catch (err) {
      last = err;
    }
  }
  if (last instanceof MinisignError) throw last;
  throw new MinisignError(last instanceof Error ? last.message : "minisign signature verification failed", {
    cause: last,
  });
}

async function readDeclaredHash(skillDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(skillDir, DECLARED_HASH_FILENAME), "utf8");
    const hex = raw.trim();
    return hex.length > 0 ? hex : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function peekSkillId(raw: string): SkillId | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return undefined;
  const block = match[1] ?? "";
  const line = /skillId:\s*([A-Za-z0-9-]+)/.exec(block);
  const parsed = SkillIdSchema.safeParse(line?.[1]);
  return parsed.success ? parsed.data : undefined;
}

async function findInstallSkillDir(root: string): Promise<string> {
  const direct = join(root, "SKILL.md");
  if (existsSync(direct) && statSync(direct).isFile()) return root;
  for (const skillId of SkillIdSchema.options) {
    const nested = join(root, skillId, "SKILL.md");
    if (existsSync(nested) && statSync(nested).isFile()) return join(root, skillId);
    const underSkills = join(root, "skills", skillId, "SKILL.md");
    if (existsSync(underSkills) && statSync(underSkills).isFile()) return join(root, "skills", skillId);
  }
  throw new AgentError("skill overlay is missing SKILL.md");
}

async function copySkillTree(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const names = await readdir(srcDir, { withFileTypes: true });
  for (const ent of names) {
    if (ent.name === "." || ent.name === "..") continue;
    if (isExcludedOverlayName(ent.name)) continue;
    const from = join(srcDir, ent.name);
    const to = join(destDir, ent.name);
    if (ent.isSymbolicLink()) {
      throw new PathEscapeError(ent.name);
    }
    await cp(from, to, { recursive: true, dereference: true, force: true });
  }
}

export type InstallSkillOverlayOpts = {
  projectRoot: string;
  source: string;
  unsigned?: boolean;
  cwd?: string;
  trustKeys?: readonly string[];
  ttyWarn?: (message: string) => void;
  lookup?: SsrfLookup;
  fetchZip?: (source: string) => Promise<{ body: Buffer }>;
};

export type InstalledSkillOverlay = {
  skillId: SkillId;
  dest: string;
  pin: SkillOverlayPin;
};

async function firstMinisig(dirs: readonly string[]): Promise<{ dir: string; rel: string } | undefined> {
  for (const dir of dirs) {
    const files = await listMinisigFiles(dir);
    const rel = files[0];
    if (rel) return { dir, rel };
  }
  return undefined;
}

async function requireSignature(
  searchDirs: readonly string[],
  computed: string,
  trustKeys: readonly string[],
  missingMessage: string,
): Promise<string> {
  const found = await firstMinisig(searchDirs);
  if (!found) {
    throw new AgentError(missingMessage);
  }
  let declared: string | undefined;
  for (const dir of searchDirs) {
    declared = await readDeclaredHash(dir);
    if (declared) break;
  }
  if (declared && declared !== computed) {
    throw new AgentError("skill overlay integrity mismatch");
  }
  const payload = declared ?? computed;
  const signature = await readFile(toFsPath(found.dir, found.rel), "utf8");
  await verifyOverlaySignature({ payload, signature, trustKeys });
  return signature;
}

export async function installSkillOverlay(opts: InstallSkillOverlayOpts): Promise<InstalledSkillOverlay> {
  const source = opts.source.trim();
  if (!source) {
    throw new AgentError("skills install requires a local directory or github:owner/repo@tag");
  }
  const trustKeys = opts.trustKeys ?? [];
  const remote = GITHUB_PREFIX.test(source);
  if (remote) {
    const parsed = parseGithubRepoSource(source);
    if (ownerLooksLikeHost(parsed.owner)) {
      throw new SsrfError("fetch host is not allowlisted");
    }
    if (!parsed.ref) {
      throw new PersistError("github: zipball fetch requires @tag");
    }
    const fetched = opts.fetchZip
      ? await opts.fetchZip(source)
      : await fetchGithubZipball(source, { lookup: opts.lookup });
    const tmp = join(opts.projectRoot, ".legion-cli", "cache", "skill-install", randomUUID());
    try {
      await unzipZipball(fetched.body, tmp);
      const unpacked = await findInstallSkillDir(tmp);
      return await materializeOverlay({
        projectRoot: opts.projectRoot,
        srcDir: unpacked,
        searchDirs: [unpacked, tmp],
        origin: `${parsed.owner}/${parsed.repo}`,
        ref: parsed.ref,
        type: "github",
        unsigned: false,
        trustKeys,
        requireSig: true,
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  if (isRemoteLooking(source)) {
    throw new AgentError("skills install is github:owner/repo@tag or a local directory");
  }
  const abs = resolve(opts.cwd ?? process.cwd(), source);
  if (isRemoteLooking(abs)) {
    throw new AgentError("skills install is github:owner/repo@tag or a local directory");
  }
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new AgentError(`skills install path is not a local directory: ${source}`);
  }
  const srcDir = await findInstallSkillDir(abs);
  return materializeOverlay({
    projectRoot: opts.projectRoot,
    srcDir,
    searchDirs: [srcDir, abs],
    origin: abs,
    type: "local",
    unsigned: Boolean(opts.unsigned),
    trustKeys,
    requireSig: false,
    ttyWarn: opts.ttyWarn,
  });
}

async function materializeOverlay(opts: {
  projectRoot: string;
  srcDir: string;
  searchDirs: readonly string[];
  origin: string;
  ref?: string;
  type: "local" | "github";
  unsigned: boolean;
  trustKeys: readonly string[];
  requireSig: boolean;
  ttyWarn?: (message: string) => void;
}): Promise<InstalledSkillOverlay> {
  const skillMd = join(opts.srcDir, "SKILL.md");
  const raw = await readFile(skillMd, "utf8");
  const dirName = basename(opts.srcDir);
  const dirIsSkillId = SkillIdSchema.safeParse(dirName).success;
  const catalogId = dirIsSkillId ? dirName : (peekSkillId(raw) ?? dirName);
  const parsed = parseSkillFrontmatter(raw, skillCatalogPath(catalogId));
  if (!parsed.ok) {
    throw new AgentError(`skill overlay frontmatter is invalid (${parsed.reason})`);
  }
  const skillId = parsed.entry.skillId;
  if (dirIsSkillId && dirName !== skillId) {
    throw new AgentError(`name "${parsed.entry.name}" must equal directory "${dirName}" and skillId "${skillId}"`);
  }

  let signature: string | undefined;
  const computedSrc = await hashSkillTree(opts.srcDir);
  if (opts.requireSig) {
    signature = await requireSignature(
      opts.searchDirs,
      computedSrc,
      opts.trustKeys,
      "remote skill install requires a minisign signature",
    );
  } else {
    const found = await firstMinisig(opts.searchDirs);
    if (found) {
      signature = await requireSignature(
        opts.searchDirs,
        computedSrc,
        opts.trustKeys,
        "local skill install requires a minisign signature or --unsigned",
      );
    } else if (!opts.unsigned) {
      throw new AgentError("local skill install requires a minisign signature or --unsigned");
    } else {
      opts.ttyWarn?.("unsigned local skill overlay; pin records no minisign signature");
    }
  }

  const dest = overlaySkillDir(opts.projectRoot, skillId);
  await rm(dest, { recursive: true, force: true });
  await copySkillTree(opts.srcDir, dest);
  const sha256 = await hashSkillTree(dest);
  if (opts.requireSig && sha256 !== computedSrc) {
    await rm(dest, { recursive: true, force: true });
    throw new AgentError("skill overlay integrity mismatch");
  }
  const pin: SkillOverlayPin = {
    schemaVersion: SCHEMA_VERSION.skillOverlay,
    skillId,
    source:
      opts.type === "github"
        ? { type: "github", origin: opts.origin, ref: opts.ref }
        : { type: "local", origin: opts.origin },
    integrity: signature ? { sha256, minisign: signature } : { sha256 },
    installedAt: new Date().toISOString(),
  };
  const checked = SkillOverlayPinSchema.parse(pin);
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, OVERLAY_PIN_FILENAME), `${JSON.stringify(checked, null, 2)}\n`, "utf8");
  return { skillId, dest, pin: checked };
}
