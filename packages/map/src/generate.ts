import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  legionPaths,
  parseYamlDocument,
  toPosixPath,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  FingerprintFileSchema,
  LegionConfigSchema,
  SCHEMA_VERSION,
  type FingerprintFile,
  type MapConfig,
  type ModuleFingerprint,
} from "@9thlevelsoftware/legion-cli-schema";
import { mergeArchitecture, renderArchitecture } from "./architecture.js";
import { MAP_HINT, refuse } from "./errors.js";
import { fingerprintHash, fingerprintRoot, uniqueSorted } from "./fingerprint.js";
import { collectLspExports, detectLspServer, MAX_LSP_FILES, type LspSpawnFn, type ResolveBinaryFn } from "./lsp.js";
import { MAX_NAMES, parseSource } from "./parse.js";
import { DEFAULT_IGNORE, resolveMapRoots, walkSources } from "./walk.js";

export type MapLspMode = "require" | "off" | "auto";

export type MapOptions = {
  refresh?: boolean;
  lsp?: MapLspMode;
  roots?: string[];
  ignore?: string[];
  resolveBinary?: ResolveBinaryFn;
  spawnLsp?: LspSpawnFn;
  /** Test hook: LSP file-loop budget (default 60s). */
  lspDeadlineMs?: number;
};

export type GenerateMapResult = {
  backend: "lsp" | "fallback";
  fingerprints: FingerprintFile;
  architecturePath: string;
  fingerprintsPath: string;
  changed: string[];
};

async function loadMapConfig(projectRoot: string): Promise<MapConfig> {
  const configPath = join(projectRoot, ".legion-cli", "config.yaml");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(raw);
  } catch (err) {
    refuse(`Invalid Legion CLI document: .legion-cli/config.yaml (${String(err)})`, MAP_HINT.doctor);
  }
  const config = LegionConfigSchema.safeParse(parsed);
  if (!config.success) {
    refuse("Invalid Legion CLI document: .legion-cli/config.yaml", MAP_HINT.doctor);
  }
  return config.data.map;
}

async function readExistingFingerprints(absPath: string): Promise<FingerprintFile | undefined> {
  try {
    const parsed = FingerprintFileSchema.safeParse(JSON.parse(await readFile(absPath, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function decideBackend(mode: MapLspMode, existing: FingerprintFile | undefined): "lsp" | "fallback" {
  if (mode === "require") return "lsp";
  if (mode === "off") return "fallback";
  return existing?.backend ?? "fallback";
}

async function lstatOrNull(absPath: string) {
  try {
    return await lstat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function dropUnsafeMapDir(mapDir: string): Promise<void> {
  const mapStat = await lstatOrNull(mapDir);
  if (!mapStat) return;
  if (mapStat.isSymbolicLink() || !mapStat.isDirectory()) {
    await rm(mapDir, { recursive: false, force: true });
  }
}

/** Drop map-dir junctions so writeFile cannot land fingerprints outside the project. */
export async function ensureRealMapDir(projectRoot: string, mapDir: string): Promise<void> {
  const legionDir = dirname(mapDir);
  await mkdir(legionDir, { recursive: true });
  await dropUnsafeMapDir(mapDir);
  await mkdir(mapDir, { recursive: true });
  const expected = resolve(await realpath(projectRoot), ".legion-cli", "map");
  const actual = await realpath(mapDir);
  const rel = toPosixPath(relative(expected, actual));
  const escaped = rel.startsWith("../") || rel === ".." || /^[A-Za-z]:/.test(rel) || rel.startsWith("/");
  if (escaped) refuse("map output escaped the project workspace", MAP_HINT.concretePaths);
}

async function writeMapFile(absPath: string, contents: string): Promise<void> {
  const st = await lstatOrNull(absPath);
  if (st?.isSymbolicLink()) await rm(absPath, { force: true });
  else if (st?.isDirectory()) await rm(absPath, { recursive: true, force: true });
  else if (st && !st.isFile()) await rm(absPath, { force: true });
  await writeFile(absPath, contents, "utf8");
}

function changedPaths(prev: FingerprintFile | undefined, next: readonly ModuleFingerprint[]): string[] {
  const old = new Map((prev?.modules ?? []).map((module) => [module.path, module.hash]));
  const changed: string[] = [];
  const seen = new Set<string>();
  for (const module of next) {
    seen.add(module.path);
    if (old.get(module.path) !== module.hash) changed.push(module.path);
  }
  for (const path of old.keys()) {
    if (!seen.has(path)) changed.push(path);
  }
  return changed.sort();
}

export async function generateMap(projectRoot: string, options: MapOptions = {}): Promise<GenerateMapResult> {
  const root = resolve(projectRoot);
  const config = await loadMapConfig(root);
  const ignore = [...new Set([...(options.ignore ?? config.ignore ?? []), ...DEFAULT_IGNORE])];
  const roots = resolveMapRoots(root, options.roots ?? config.roots);
  const files = await walkSources({ projectRoot: root, roots, ignore });

  const paths = legionPaths(root);
  const fingerprintsPath = join(paths.mapDir, "fingerprints.json");
  const architecturePath = join(paths.mapDir, "ARCHITECTURE.md");
  await dropUnsafeMapDir(paths.mapDir);
  const existing = await readExistingFingerprints(fingerprintsPath);
  const lspMode = options.lsp ?? "auto";
  let backend = decideBackend(lspMode, existing);

  const parsed = files.map((file) => {
    const result = parseSource(file.path, file.text);
    return { ...file, exports: result.exports, imports: result.imports };
  });
  const exportsByPath = new Map(parsed.map((file) => [file.path, file.exports]));

  if (backend === "lsp") {
    let detected: ReturnType<typeof detectLspServer> = null;
    try {
      detected = detectLspServer(root, roots, options.resolveBinary);
    } catch {
      detected = null;
    }
    if (!detected) {
      if (lspMode === "require") {
        refuse("no language server on PATH", MAP_HINT.noLsp);
      }
      backend = "fallback";
    } else {
      const lspFiles = parsed.filter((file) => detected.languages.has(file.language)).slice(0, MAX_LSP_FILES);
      const lspExports = await collectLspExports({
        projectRoot: root,
        files: lspFiles,
        command: detected.command,
        args: detected.args,
        spawnLsp: options.spawnLsp,
        deadlineMs: options.lspDeadlineMs,
      });
      if (lspExports) {
        for (const [path, names] of lspExports) exportsByPath.set(path, names);
      } else {
        backend = "fallback";
      }
    }
  }

  const modules: ModuleFingerprint[] = parsed.map((file) => {
    const exports = uniqueSorted(exportsByPath.get(file.path) ?? file.exports).slice(0, MAX_NAMES);
    const imports = uniqueSorted(file.imports).slice(0, MAX_NAMES);
    return {
      path: file.path,
      language: file.language,
      exports,
      imports,
      hash: fingerprintHash(file.path, exports, imports),
    };
  });

  const changed = changedPaths(existing, modules);
  const rootHash = fingerprintRoot(modules);
  const unchanged = Boolean(
    existing && existing.backend === backend && existing.rootHash === rootHash && changed.length === 0,
  );

  let existingArch: string | undefined;
  const archStat = await lstatOrNull(architecturePath);
  if (archStat?.isSymbolicLink()) {
    await rm(architecturePath, { force: true });
  } else if (archStat?.isDirectory()) {
    await rm(architecturePath, { recursive: true, force: true });
  } else if (archStat && !archStat.isFile()) {
    await rm(architecturePath, { force: true });
  } else if (archStat) {
    existingArch = await readFile(architecturePath, "utf8");
  }

  if (unchanged && existing) {
    if (options.refresh || existingArch === undefined) {
      await ensureRealMapDir(root, paths.mapDir);
      await writeMapFile(architecturePath, mergeArchitecture(existingArch, renderArchitecture(existing)));
    }
    return {
      backend: existing.backend,
      fingerprints: existing,
      architecturePath,
      fingerprintsPath,
      changed: [],
    };
  }

  const fingerprints = FingerprintFileSchema.parse({
    schemaVersion: SCHEMA_VERSION.fingerprint,
    generatedAt: new Date().toISOString(),
    backend,
    rootHash,
    modules,
  });

  await ensureRealMapDir(root, paths.mapDir);
  await writeMapFile(fingerprintsPath, `${JSON.stringify(fingerprints, null, 2)}\n`);
  await writeMapFile(architecturePath, mergeArchitecture(existingArch, renderArchitecture(fingerprints)));

  return { backend, fingerprints, architecturePath, fingerprintsPath, changed };
}
