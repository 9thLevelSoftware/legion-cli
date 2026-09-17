import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DesignSystemPackageSchema,
  LegionConfigSchema,
  SCHEMA_VERSION,
  type DesignSystemPackage,
} from "@9thlevelsoftware/legion-cli-schema";
import {
  fetchGithubZipball,
  legionPaths,
  MinisignError,
  parseGithubRepoSource,
  PathEscapeError,
  PersistError,
  readNinthlevelMinisignPub,
  SsrfError,
  unzipZipball,
  verifyMinisign,
  type GithubRepoRef,
  type SsrfLookup,
} from "@9thlevelsoftware/legion-cli-persist";
import { parse as parseYaml } from "yaml";
import { readActive, writeActive } from "./active.js";
import { DS_HINT, refuse } from "./errors.js";
import { assertIntegrity, hashPackageFiles, parseIntegrityPin } from "./integrity.js";
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

function existsSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function resolveTrustKey(projectRoot: string, key: string): string {
  const trimmed = key.trim();
  if (!trimmed || trimmed.includes("\n") || /untrusted comment:/i.test(trimmed)) return trimmed;
  if (existsSafe(trimmed)) return trimmed;
  const relative = resolve(projectRoot, trimmed);
  if (existsSafe(relative)) return relative;
  return trimmed;
}

async function loadTrustKeyMaterial(projectRoot: string, key: string): Promise<string> {
  const resolved = resolveTrustKey(projectRoot, key);
  if (!existsSafe(resolved)) return key;
  try {
    if ((await stat(resolved)).isFile()) return await readFile(resolved, "utf8");
  } catch {
    return key;
  }
  return key;
}

async function collectTrustKeys(projectRoot: string, extra?: string[]): Promise<string[]> {
  const fromConfig = await readConfigTrustKeys(projectRoot);
  const raw = [...(extra ?? []), ...fromConfig];
  const loaded: string[] = [];
  for (const key of raw) {
    loaded.push(await loadTrustKeyMaterial(projectRoot, key));
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

async function materializeFromDir(opts: {
  projectRoot: string;
  srcDir: string;
  origin: DesignSystemPackage["source"];
  expectedSha?: string;
  fromGithub: boolean;
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
  const files = declaredFiles(parsed.data);
  for (const file of files) {
    if (file === "manifest.json") continue;
    if (!existsSync(join(opts.srcDir, file))) {
      refuse(`design-system package is missing ${file}`, DS_HINT.install);
    }
  }

  const copied = files.filter((file) => file !== "manifest.json");
  const manifestSha = parsed.data.integrity?.sha256;
  if (opts.expectedSha && manifestSha && opts.expectedSha !== manifestSha) {
    refuse("design-system integrity.sha256 mismatch", DS_HINT.install);
  }
  const expected = opts.expectedSha ?? manifestSha;
  const requireIntegrity = opts.fromGithub || parsed.data.source.type === "github";
  const hashed = await assertIntegrity(opts.srcDir, copied, expected, { required: requireIntegrity });
  const sha = hashed ?? (await hashPackageFiles(opts.srcDir, copied));
  if (parsed.data.integrity?.minisign) {
    await assertMinisign(sha, parsed.data.integrity.minisign, opts.trustKeys);
  } else if (opts.fromGithub) {
    refuse("remote design-system install requires integrity.minisign", DS_HINT.install);
  }

  const dest = designPaths(opts.projectRoot).packageDir(parsed.data.id);
  await mkdir(dest, { recursive: true });
  const alreadyInPlace = sameDir(opts.srcDir, dest);
  if (!alreadyInPlace) {
    for (const file of files) {
      if (file === "manifest.json") continue;
      await cp(join(opts.srcDir, file), join(dest, file), { dereference: true, force: true });
    }
    for (const extra of ["components.html", "components.manifest.json"]) {
      if (existsSync(join(opts.srcDir, extra))) {
        await cp(join(opts.srcDir, extra), join(dest, extra), { dereference: true, force: true });
      }
    }
  }

  const manifest: DesignSystemPackage = {
    ...parsed.data,
    schemaVersion: SCHEMA_VERSION.designSystem,
    source: opts.origin,
    integrity: {
      sha256: sha,
      ...(parsed.data.integrity?.minisign ? { minisign: parsed.data.integrity.minisign } : {}),
    },
  };
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
  let parsed: GithubRepoRef;
  try {
    parsed = parseGithubRepoSource(source);
  } catch (err) {
    wrapPersist(err);
  }
  if (!parsed.ref) {
    refuse("github: zipball fetch requires @tag", DS_HINT.localOnly);
  }

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
      fromGithub: true,
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
  const pin = parseIntegrityPin(opts.integrity);
  const trustKeys = await collectTrustKeys(opts.projectRoot, opts.trustKeys);
  return materializeFromDir({
    projectRoot: opts.projectRoot,
    srcDir,
    origin: { type: "local", origin: srcDir },
    expectedSha: pin,
    fromGithub: false,
    trustKeys,
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
