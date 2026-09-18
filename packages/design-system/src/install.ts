import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  DesignSystemPackageSchema,
  LegionConfigSchema,
  SCHEMA_VERSION,
  type DesignSystemPackage,
} from "@9thlevelsoftware/legion-cli-schema";
import {
  assertResolvedInside,
  fetchGithubZipball,
  hashTreeRecords,
  legionPaths,
  MinisignError,
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
import { parse as parseYaml } from "yaml";
import { readActive, writeActive } from "./active.js";
import { DS_HINT, refuse } from "./errors.js";
import { assertIntegrity, canonicalManifestJson, hashPackageFiles, parseIntegrityPin } from "./integrity.js";
import { OD_SCHEMA_VERSION } from "./od.js";
import { assertSafeRelative, CRAFT_SLUGS, designPaths } from "./paths.js";
import { assertInitialized } from "./project.js";
import { assertInstallSource, isGithubColonSource, resolveLocalDir } from "./source.js";

export type InstallResult = {
  id: string;
  dest: string;
  manifest: DesignSystemPackage;
};

export type InstallOpts = {
  projectRoot: string;
  source: string;
  cwd?: string;
  integrity?: string;
  allowBranch?: boolean;
  lookup?: SsrfLookup;
  trustKeys?: string[];
  fetchZipball?: (
    source: string,
    opts?: { lookup?: SsrfLookup; allowBranch?: boolean },
  ) => Promise<{ body: Buffer }>;
};

function declaredFiles(manifest: DesignSystemPackage): string[] {
  const files = ["manifest.json", manifest.files.design, manifest.files.tokens];
  if (manifest.files.usage) files.push(assertSafeRelative(manifest.files.usage, "files.usage"));
  return files;
}

function wrapPersist(err: unknown): never {
  if (err instanceof PathEscapeError) refuse(err.message, DS_HINT.install);
  if (err instanceof MinisignError) refuse(err.message, DS_HINT.install);
  if (err instanceof SsrfError) refuse(err.message, DS_HINT.install);
  if (err instanceof PersistError) refuse(err.message, DS_HINT.install);
  throw err;
}

async function readConfigTrustKeys(projectRoot: string): Promise<string[]> {
  const configPath = join(projectRoot, ".legion-cli", "config.yaml");
  if (!existsSync(configPath)) return [];
  try {
    const raw = parseYaml(await readFile(configPath, "utf8"));
    const parsed = LegionConfigSchema.safeParse(raw);
    if (!parsed.success) return [];
    return parsed.data.skills.trustKeys;
  } catch {
    return [];
  }
}

async function trustKeyMaterial(key: string, roots: readonly string[]): Promise<string> {
  const trimmed = key.trim();
  if (!trimmed || trimmed.includes("\n") || /untrusted comment:/i.test(trimmed)) return trimmed;
  for (const root of roots) {
    const candidate = resolve(root, trimmed);
    try {
      if ((await stat(candidate)).isFile()) return await readFile(candidate, "utf8");
    } catch {
      // try the next root
    }
  }
  return trimmed;
}

async function collectTrustKeys(projectRoot: string, extra?: string[]): Promise<string[]> {
  const loaded: string[] = [];
  for (const key of extra ?? []) {
    loaded.push(await trustKeyMaterial(key, [process.cwd(), projectRoot]));
  }
  for (const key of await readConfigTrustKeys(projectRoot)) {
    loaded.push(await trustKeyMaterial(key, [projectRoot]));
  }
  return loaded;
}

async function assertMinisign(payload: string, signature: string, trustKeys: string[]): Promise<void> {
  const keys = [readNinthlevelMinisignPub(), ...trustKeys];
  for (const publicKey of keys) {
    try {
      await verifyMinisign({ payload, signature, publicKey });
      return;
    } catch {
      // try the next trusted key
    }
  }
  refuse("design-system minisign verification failed", DS_HINT.install);
}

async function listTreeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel ? toFsPath(dir, rel) : dir;
    const ents = await readdir(abs, { withFileTypes: true });
    for (const ent of ents) {
      if (ent.name === "." || ent.name === "..") continue;
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) throw new PathEscapeError(child);
      if (ent.isDirectory()) await walk(child);
      else if (ent.isFile()) out.push(toPosixPath(child));
    }
  }
  await walk("");
  return out.sort();
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function assertSafePackageDest(projectRoot: string, dest: string): Promise<void> {
  const root = resolve(projectRoot);
  const expected = resolve(designPaths(projectRoot).packageDir(basename(dest)));
  if (!samePath(dest, expected)) {
    refuse("design-system destination is outside the project design directory", DS_HINT.install);
  }
  assertResolvedInside(root, dest, dest);
  let current = resolve(dest);
  for (;;) {
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) {
        refuse("design-system destination must not be a symlink", DS_HINT.install);
      }
    } catch (err) {
      if (err instanceof PathEscapeError) wrapPersist(err);
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (samePath(current, root)) return;
    const parent = dirname(current);
    if (samePath(parent, current)) return;
    current = parent;
  }
}

async function hashGithubPackage(dir: string, files: string[], manifest: DesignSystemPackage): Promise<string> {
  const records = await Promise.all(
    files.map(async (path) => {
      const abs = toFsPath(dir, path);
      const st = await lstat(abs);
      if (st.isSymbolicLink() || !st.isFile()) throw new PathEscapeError(path);
      return { path, bytes: await readFile(abs) };
    }),
  );
  records.push({ path: "manifest.json", bytes: Buffer.from(canonicalManifestJson(manifest), "utf8") });
  return hashTreeRecords(records);
}

async function replaceDestTree(srcDir: string, dest: string, files: string[], projectRoot: string): Promise<void> {
  await assertSafePackageDest(projectRoot, dest);
  const staging = join(legionPaths(projectRoot).cacheDir, "design-system", `pkg-${randomUUID()}`);
  try {
    await mkdir(staging, { recursive: true });
    for (const file of files) {
      const to = toFsPath(staging, file);
      await mkdir(dirname(to), { recursive: true });
      await cp(toFsPath(srcDir, file), to, { dereference: true, force: true });
    }
    await assertSafePackageDest(projectRoot, dest);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dirname(dest), { recursive: true });
    await assertSafePackageDest(projectRoot, dest);
    await rename(staging, dest);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    wrapPersist(err);
  }
}

async function materializeFromDir(opts: {
  projectRoot: string;
  srcDir: string;
  origin: DesignSystemPackage["source"];
  expectedSha?: string;
  trustKeys: string[];
}): Promise<InstallResult> {
  const manifestPath = join(opts.srcDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    refuse("design-system install requires a Legion CLI manifest.json", DS_HINT.install);
  }
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as { schemaVersion?: string };
  if (raw.schemaVersion === OD_SCHEMA_VERSION) {
    refuse("raw OpenDesign folders cannot be installed", DS_HINT.importOd);
  }
  const parsed = DesignSystemPackageSchema.safeParse(raw);
  if (!parsed.success) {
    refuse("design-system install requires schemaVersion legion-cli-design-system/v1", DS_HINT.importOd);
  }
  const declared = declaredFiles(parsed.data);
  for (const file of declared) {
    if (file === "manifest.json") continue;
    const abs = join(opts.srcDir, file);
    let st;
    try {
      st = await lstat(abs);
    } catch {
      refuse(`design-system package is missing ${file}`, DS_HINT.install);
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      refuse(`design-system package ${file} must be a regular file`, DS_HINT.install);
    }
  }

  const remote = opts.origin.type === "github";
  const convertingFromGithub = !remote && parsed.data.source.type === "github";
  let tree: string[];
  try {
    tree = await listTreeFiles(opts.srcDir);
  } catch (err) {
    wrapPersist(err);
  }
  const hashedFiles = remote
    ? tree.filter((file) => file !== "manifest.json")
    : declared.filter((file) => file !== "manifest.json");
  const extras = ["components.html", "components.manifest.json"];
  const localCopy = remote
    ? tree.filter((file) => file !== "manifest.json")
    : [...new Set([...hashedFiles, ...extras.filter((file) => existsSync(join(opts.srcDir, file)))])];

  const manifestSha = parsed.data.integrity?.sha256;
  if (opts.expectedSha && manifestSha && opts.expectedSha !== manifestSha) {
    refuse("design-system integrity.sha256 mismatch", DS_HINT.install);
  }
  const expected = convertingFromGithub ? opts.expectedSha : (opts.expectedSha ?? manifestSha);
  let sha: string;
  if (remote) {
    if (!expected) refuse("remote design-system install requires integrity.sha256", DS_HINT.install);
    try {
      sha = await hashGithubPackage(opts.srcDir, hashedFiles, parsed.data);
    } catch (err) {
      wrapPersist(err);
    }
    if (sha !== expected) refuse("design-system integrity.sha256 mismatch", DS_HINT.install);
  } else {
    const hashed = await assertIntegrity(opts.srcDir, hashedFiles, expected, { required: false });
    sha = hashed ?? (await hashPackageFiles(opts.srcDir, hashedFiles));
  }
  const keepMinisign = Boolean(parsed.data.integrity?.minisign) && !convertingFromGithub;
  if (keepMinisign && parsed.data.integrity?.minisign) {
    await assertMinisign(sha, parsed.data.integrity.minisign, opts.trustKeys);
  } else if (opts.origin.type === "github") {
    refuse("remote design-system install requires integrity.minisign", DS_HINT.install);
  }

  const dest = designPaths(opts.projectRoot).packageDir(parsed.data.id);
  await assertSafePackageDest(opts.projectRoot, dest);
  const alreadyInPlace = sameDir(opts.srcDir, dest);
  if (!alreadyInPlace) {
    await replaceDestTree(opts.srcDir, dest, localCopy, opts.projectRoot);
  }

  const manifest: DesignSystemPackage = {
    ...parsed.data,
    schemaVersion: SCHEMA_VERSION.designSystem,
    source: opts.origin,
    integrity: {
      sha256: sha,
      ...(keepMinisign && parsed.data.integrity?.minisign ? { minisign: parsed.data.integrity.minisign } : {}),
    },
  };
  await mkdir(dirname(join(dest, "manifest.json")), { recursive: true });
  await writeFile(join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const prev = (await readActive(opts.projectRoot)) ?? {
    schemaVersion: SCHEMA_VERSION.designActive,
    craft: [...CRAFT_SLUGS],
    brandViolation: false,
  };
  await writeActive(opts.projectRoot, {
    ...prev,
    packageId: manifest.id,
    craft: prev.craft.length > 0 ? prev.craft : [...CRAFT_SLUGS],
    brandViolation: false,
  });

  return { id: manifest.id, dest, manifest };
}

async function installFromGithub(opts: InstallOpts, source: string): Promise<InstallResult> {
  const pin = parseIntegrityPin(opts.integrity);
  const trustKeys = await collectTrustKeys(opts.projectRoot, opts.trustKeys);
  const fetchZip = opts.fetchZipball ?? fetchGithubZipball;
  let zip: Buffer;
  try {
    const fetched = await fetchZip(source, { allowBranch: opts.allowBranch, lookup: opts.lookup });
    zip = fetched.body;
  } catch (err) {
    wrapPersist(err);
  }

  const cacheRoot = join(legionPaths(opts.projectRoot).cacheDir, "design-system");
  await mkdir(cacheRoot, { recursive: true });
  const tmp = await mkdtemp(join(cacheRoot, "zip-"));
  try {
    try {
      await unzipZipball(zip, tmp);
    } catch (err) {
      wrapPersist(err);
    }
    return await materializeFromDir({
      projectRoot: opts.projectRoot,
      srcDir: tmp,
      origin: { type: "github", origin: source },
      expectedSha: pin,
      trustKeys,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Local dir copy, or github:owner/repo@tag via persist fetch/unzip/minisign. Never executes package files. */
export async function install(opts: InstallOpts): Promise<InstallResult> {
  assertInitialized(opts.projectRoot);
  const source = opts.source.trim();
  assertInstallSource(source);
  if (isGithubColonSource(source)) {
    return installFromGithub(opts, source);
  }
  const srcDir = resolveLocalDir(source, opts.cwd ?? process.cwd());
  return materializeFromDir({
    projectRoot: opts.projectRoot,
    srcDir,
    origin: { type: "local", origin: srcDir },
    expectedSha: parseIntegrityPin(opts.integrity),
    trustKeys: await collectTrustKeys(opts.projectRoot, opts.trustKeys),
  });
}

export const installLocalDir = install;

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}
