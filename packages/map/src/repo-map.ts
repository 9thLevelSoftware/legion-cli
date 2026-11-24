import { posix } from "node:path";
import type { ModuleFingerprint } from "@9thlevelsoftware/legion-cli-schema";

export type RankedModule = {
  path: string;
  rank: number;
  exports: string[];
  imports: string[];
  language: string;
};

export type RepoMapOptions = {
  maxCharacters?: number;
  dampingFactor?: number;
  iterations?: number;
};

/** Pairwise suffix-scan iterations in `computeRepoPageRank` (F-024 / KD-3 work counter). */
export const repoMapWork = { suffixScanIterations: 0 };

export function resetRepoMapWork(): void {
  repoMapWork.suffixScanIterations = 0;
}

const JS_TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

const JS_TS_EXT_REMAP: Record<string, readonly string[]> = {
  ".js": [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"],
  ".jsx": [".tsx", ".ts", ".jsx", ".js"],
  ".mjs": [".mts", ".ts", ".mjs", ".js"],
  ".cjs": [".cts", ".ts", ".cjs", ".js"],
  ".ts": [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"],
  ".tsx": [".tsx", ".ts", ".jsx", ".js"],
  ".mts": [".mts", ".ts", ".mjs", ".js"],
  ".cts": [".cts", ".ts", ".cjs", ".js"],
};

const GO_STDLIB_PREFIXES = new Set([
  "archive",
  "bufio",
  "bytes",
  "cmp",
  "compress",
  "container",
  "context",
  "crypto",
  "database",
  "debug",
  "embed",
  "encoding",
  "errors",
  "expvar",
  "flag",
  "fmt",
  "go",
  "hash",
  "html",
  "image",
  "index",
  "io",
  "iter",
  "log",
  "maps",
  "math",
  "mime",
  "net",
  "os",
  "path",
  "reflect",
  "regexp",
  "runtime",
  "slices",
  "sort",
  "strconv",
  "strings",
  "structs",
  "sync",
  "syscall",
  "testing",
  "text",
  "time",
  "unicode",
  "unique",
  "unsafe",
  "weak",
]);

function addSuffixEntries(index: Map<string, number[]>, pathKey: string, idx: number): void {
  let rest = pathKey;
  while (true) {
    const hits = index.get(rest);
    if (hits) hits.push(idx);
    else index.set(rest, [idx]);
    const slash = rest.indexOf("/");
    if (slash < 0) break;
    rest = rest.slice(slash + 1);
  }
}

function pickExact(exactIndex: ReadonlyMap<string, number>, key: string, selfIdx: number): number | undefined {
  const hit = exactIndex.get(key);
  return hit !== undefined && hit !== selfIdx ? hit : undefined;
}

function pickFromIndex(
  index: ReadonlyMap<string, readonly number[]>,
  keys: readonly string[],
  selfIdx: number,
): number | undefined {
  for (const key of keys) {
    const hits = index.get(key);
    if (!hits) continue;
    for (const j of hits) {
      if (j !== selfIdx) return j;
    }
  }
  return undefined;
}

function resolveJsTsImport(
  modPath: string,
  imp: string,
  selfIdx: number,
  exactIndex: ReadonlyMap<string, number>,
  suffixIndex: ReadonlyMap<string, readonly number[]>,
): number | undefined {
  if (imp === "." || imp === ".." || imp.startsWith("./") || imp.startsWith("../")) {
    const baseDir = posix.dirname(modPath);
    const joined = baseDir === "." ? imp : `${baseDir}/${imp}`;
    const norm = posix.normalize(joined).replace(/\/+$/, "");
    if (norm === ".." || norm.startsWith("../")) return undefined;
    if (norm === ".") {
      for (const ext of JS_TS_EXTS) {
        const hit = pickExact(exactIndex, `index${ext}`, selfIdx);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    const ext = posix.extname(norm).toLowerCase();
    const remap = JS_TS_EXT_REMAP[ext];
    if (remap) {
      const direct = pickExact(exactIndex, norm, selfIdx);
      if (direct !== undefined) return direct;
      const stem = norm.slice(0, -ext.length);
      for (const candidateExt of remap) {
        const hit = pickExact(exactIndex, `${stem}${candidateExt}`, selfIdx);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
    const exact = pickExact(exactIndex, norm, selfIdx);
    if (exact !== undefined) return exact;
    for (const candidateExt of JS_TS_EXTS) {
      const hit = pickExact(exactIndex, `${norm}${candidateExt}`, selfIdx);
      if (hit !== undefined) return hit;
    }
    for (const candidateExt of JS_TS_EXTS) {
      const hit = pickExact(exactIndex, `${norm}/index${candidateExt}`, selfIdx);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  const ext = posix.extname(imp).toLowerCase();
  const remap = JS_TS_EXT_REMAP[ext];
  const keys = [imp];
  if (remap) {
    const stem = imp.slice(0, -ext.length);
    for (const candidateExt of remap) keys.push(`${stem}${candidateExt}`);
  } else {
    for (const candidateExt of JS_TS_EXTS) keys.push(`${imp}${candidateExt}`);
    for (const candidateExt of JS_TS_EXTS) keys.push(`${imp}/index${candidateExt}`);
  }
  return pickFromIndex(suffixIndex, keys, selfIdx);
}

function resolvePythonImport(
  modPath: string,
  imp: string,
  selfIdx: number,
  exactIndex: ReadonlyMap<string, number>,
  suffixIndex: ReadonlyMap<string, readonly number[]>,
): number | undefined {
  if (imp.startsWith(".")) {
    const match = /^(\.+)(.*)$/.exec(imp);
    if (!match) return undefined;
    const dots = match[1].length;
    const rest = match[2];
    let curDir = posix.dirname(modPath);
    for (let d = 1; d < dots; d++) {
      if (curDir === "." || curDir === "") return undefined;
      curDir = posix.dirname(curDir);
    }
    const relMod = rest ? rest.replaceAll(".", "/") : "";
    const base = relMod ? (curDir === "." ? relMod : `${curDir}/${relMod}`) : curDir;
    if (base === ".") return pickExact(exactIndex, "__init__.py", selfIdx);
    return pickExact(exactIndex, `${base}.py`, selfIdx) ?? pickExact(exactIndex, `${base}/__init__.py`, selfIdx);
  }

  const slashPath = imp.replaceAll(".", "/");
  const rootHit =
    pickExact(exactIndex, `${slashPath}.py`, selfIdx) ??
    pickExact(exactIndex, `${slashPath}/__init__.py`, selfIdx);
  if (rootHit !== undefined) return rootHit;

  let dir = posix.dirname(modPath);
  while (dir !== "." && dir !== "") {
    const hit =
      pickExact(exactIndex, `${dir}/${slashPath}.py`, selfIdx) ??
      pickExact(exactIndex, `${dir}/${slashPath}/__init__.py`, selfIdx);
    if (hit !== undefined) return hit;
    dir = posix.dirname(dir);
  }

  return pickFromIndex(suffixIndex, [`${slashPath}.py`, `${slashPath}/__init__.py`], selfIdx);
}

function resolveRustImport(
  modPath: string,
  imp: string,
  selfIdx: number,
  exactIndex: ReadonlyMap<string, number>,
  suffixIndex: ReadonlyMap<string, readonly number[]>,
): number | undefined {
  let cleaned = imp.trim();
  const braceIdx = cleaned.indexOf("::{");
  if (braceIdx !== -1) cleaned = cleaned.slice(0, braceIdx);
  else if (cleaned.endsWith("::*")) cleaned = cleaned.slice(0, -3);
  else cleaned = cleaned.replace(/\s+as\s+[A-Za-z_]\w*$/, "").trim();

  const parts = cleaned.split("::").filter(Boolean);
  if (parts.length === 0) return undefined;

  const tryExact = (base: string, segs: readonly string[]): number | undefined => {
    if (segs.length === 0) return undefined;
    const rel = segs.join("/");
    const full = base && base !== "." ? `${base}/${rel}` : rel;
    return pickExact(exactIndex, `${full}.rs`, selfIdx) ?? pickExact(exactIndex, `${full}/mod.rs`, selfIdx);
  };

  const tryWithItemFallback = (base: string, segs: readonly string[]): number | undefined => {
    const direct = tryExact(base, segs);
    if (direct !== undefined) return direct;
    if (segs.length > 1) return tryExact(base, segs.slice(0, -1));
    return undefined;
  };

  const trySuffixWithFallback = (segs: readonly string[]): number | undefined => {
    if (segs.length === 0) return undefined;
    const rel = segs.join("/");
    const keys = [`${rel}.rs`, `${rel}/mod.rs`];
    if (segs.length > 1) {
      const parentRel = segs.slice(0, -1).join("/");
      keys.push(`${parentRel}.rs`, `${parentRel}/mod.rs`);
    }
    return pickFromIndex(suffixIndex, keys, selfIdx);
  };

  if (parts[0] === "crate") {
    const rest = parts.slice(1);
    if (rest.length === 0) return undefined;
    const srcIdx = modPath.lastIndexOf("/src/");
    const crateBase = modPath.startsWith("src/")
      ? "src"
      : srcIdx >= 0
        ? modPath.slice(0, srcIdx + 4)
        : ".";
    const direct = tryWithItemFallback(crateBase, rest);
    if (direct !== undefined) return direct;
    if (crateBase === ".") {
      const modDir = posix.dirname(modPath);
      if (modDir !== ".") {
        const dirHit = tryWithItemFallback(modDir, rest);
        if (dirHit !== undefined) return dirHit;
      }
    }
    return trySuffixWithFallback(rest);
  }

  if (parts[0] === "super") {
    let superCount = 0;
    while (superCount < parts.length && parts[superCount] === "super") superCount += 1;
    const rest = parts.slice(superCount);
    const baseName = posix.basename(modPath);
    let dir = posix.dirname(modPath);
    let skipsRemaining =
      baseName === "mod.rs" || baseName === "lib.rs" || baseName === "main.rs"
        ? superCount
        : superCount - 1;
    while (skipsRemaining > 0) {
      if (dir === "." || dir === "") return undefined;
      dir = posix.dirname(dir);
      skipsRemaining -= 1;
    }
    if (rest.length === 0) {
      return dir === "."
        ? pickExact(exactIndex, "lib.rs", selfIdx) ?? pickExact(exactIndex, "main.rs", selfIdx)
        : pickExact(exactIndex, `${dir}/mod.rs`, selfIdx) ?? pickExact(exactIndex, `${dir}.rs`, selfIdx);
    }
    const hit = tryWithItemFallback(dir, rest);
    if (hit !== undefined) return hit;
    if (rest.length === 1 && dir !== ".") {
      return pickExact(exactIndex, `${dir}/mod.rs`, selfIdx) ?? pickExact(exactIndex, `${dir}.rs`, selfIdx);
    }
    return undefined;
  }

  if (parts[0] === "self") {
    const rest = parts.slice(1);
    if (rest.length === 0) return undefined;
    const baseName = posix.basename(modPath);
    const dir = posix.dirname(modPath);
    const selfDir =
      baseName === "mod.rs" || baseName === "lib.rs" || baseName === "main.rs"
        ? dir
        : dir === "."
          ? baseName.replace(/\.rs$/, "")
          : `${dir}/${baseName.replace(/\.rs$/, "")}`;
    return tryWithItemFallback(selfDir, rest) ?? tryWithItemFallback(dir, rest);
  }

  return trySuffixWithFallback(parts);
}

function resolveGoImport(
  modPath: string,
  imp: string,
  selfIdx: number,
  goDirIndex: ReadonlyMap<string, readonly number[]>,
): number[] {
  if (imp.startsWith("./") || imp.startsWith("../")) {
    const baseDir = posix.dirname(modPath);
    const joined = baseDir === "." ? imp : `${baseDir}/${imp}`;
    const targetDir = posix.normalize(joined).replace(/\/+$/, "");
    const hits = goDirIndex.get(targetDir);
    return hits ? hits.filter((j) => j !== selfIdx) : [];
  }
  const slashIdx = imp.indexOf("/");
  if (slashIdx < 0) return [];
  const firstSeg = imp.slice(0, slashIdx);
  if (GO_STDLIB_PREFIXES.has(firstSeg)) return [];
  let rest = imp;
  while (true) {
    const hits = goDirIndex.get(rest);
    if (hits) {
      const targets = hits.filter((j) => j !== selfIdx);
      if (targets.length > 0) return targets;
    }
    const nextSlash = rest.indexOf("/");
    if (nextSlash < 0) break;
    rest = rest.slice(nextSlash + 1);
  }
  return [];
}

/**
 * Computes PageRank centrality over repository module dependency graph.
 * Identifies architectural "hubs" that are heavily referenced across the codebase.
 */
export function computeRepoPageRank(
  modules: readonly ModuleFingerprint[],
  opts: RepoMapOptions = {},
): RankedModule[] {
  const n = modules.length;
  if (n === 0) return [];

  const damping = opts.dampingFactor ?? 0.85;
  const iterations = opts.iterations ?? 20;

  // Exact path, trailing-segment suffix, and Go package directory indexes (all O(n)).
  const exactIndex = new Map<string, number>();
  const suffixIndex = new Map<string, number[]>();
  const goDirIndex = new Map<string, number[]>();

  for (let j = 0; j < n; j++) {
    const path = modules[j].path.replaceAll("\\", "/");
    if (!exactIndex.has(path)) exactIndex.set(path, j);
    addSuffixEntries(suffixIndex, path, j);
    if (modules[j].language === "go") {
      const dir = posix.dirname(path);
      if (dir !== "." && dir !== "") {
        addSuffixEntries(goDirIndex, dir, j);
      }
    }
  }

  const incoming = Array.from({ length: n }, () => [] as number[]);
  const outDegree = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const mod = modules[i];
    const modPath = mod.path.replaceAll("\\", "/");
    const seenTargets = new Set<number>();

    for (const rawImp of mod.imports) {
      const imp = rawImp.replaceAll("\\", "/");
      if (mod.language === "go") {
        for (const j of resolveGoImport(modPath, imp, i, goDirIndex)) {
          if (seenTargets.has(j)) continue;
          seenTargets.add(j);
          incoming[j].push(i);
          outDegree[i]++;
        }
        continue;
      }

      const resolved =
        mod.language === "ts" || mod.language === "js"
          ? resolveJsTsImport(modPath, imp, i, exactIndex, suffixIndex)
          : mod.language === "py"
            ? resolvePythonImport(modPath, imp, i, exactIndex, suffixIndex)
            : mod.language === "rs"
              ? resolveRustImport(modPath, imp, i, exactIndex, suffixIndex)
              : pickFromIndex(suffixIndex, [imp, `${imp}.ts`, `${imp}.js`], i);

      if (resolved === undefined || seenTargets.has(resolved)) continue;
      seenTargets.add(resolved);
      incoming[resolved].push(i);
      outDegree[i]++;
    }
  }

  // Initialize PageRank uniformly
  let ranks = new Array<number>(n).fill(1 / n);

  // Power iteration
  for (let iter = 0; iter < iterations; iter++) {
    const nextRanks = new Array<number>(n).fill((1 - damping) / n);
    for (let u = 0; u < n; u++) {
      let sum = 0;
      for (const v of incoming[u]) {
        if (outDegree[v] > 0) {
          sum += ranks[v] / outDegree[v];
        }
      }
      nextRanks[u] += damping * sum;
    }
    ranks = nextRanks;
  }

  let maxRank = 1e-6;
  for (const rank of ranks) {
    if (rank > maxRank) maxRank = rank;
  }

  return modules
    .map((mod, idx) => ({
      path: mod.path,
      rank: Math.round((ranks[idx] / maxRank) * 1000) / 1000,
      exports: mod.exports,
      imports: mod.imports,
      language: mod.language,
    }))
    .sort((a, b) => b.rank - a.rank);
}

/**
 * Formats a concise, token-budgeted repository map string suitable for prompt injection.
 */
export function formatRepoMap(
  rankedModules: readonly RankedModule[],
  maxChars = 6000,
): string {
  const lines: string[] = ["# Repository Architecture Map (Ranked by Centrality)"];
  let curLength = lines[0].length + 1;

  for (const mod of rankedModules) {
    if (mod.exports.length === 0 && mod.rank < 0.1) continue;
    const exportSummary = mod.exports.slice(0, 15).join(", ");
    const line = `- ${mod.path} (rank: ${mod.rank.toFixed(2)}): [${exportSummary}${mod.exports.length > 15 ? "..." : ""}]`;
    if (curLength + line.length + 1 > maxChars) break;
    lines.push(line);
    curLength += line.length + 1;
  }

  return lines.join("\n");
}
