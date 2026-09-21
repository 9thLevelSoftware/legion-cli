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

  // Map paths to indices
  const pathToIdx = new Map<string, number>();
  modules.forEach((mod, idx) => pathToIdx.set(mod.path, idx));

  // Adjacency and out-degrees
  // Edge v -> u exists if v imports u (u is referenced by v)
  const incoming = Array.from({ length: n }, () => [] as number[]);
  const outDegree = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const mod = modules[i];
    for (const imp of mod.imports) {
      // Find matching module by relative or suffix path
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const candidate = modules[j].path;
        if (
          candidate === imp ||
          candidate.endsWith(`/${imp}`) ||
          candidate.endsWith(`/${imp}.ts`) ||
          candidate.endsWith(`/${imp}.js`)
        ) {
          incoming[j].push(i);
          outDegree[i]++;
          break;
        }
      }
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

  // Normalize ranks so highest is 1.0 (or proportional)
  const maxRank = Math.max(...ranks, 1e-6);

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
