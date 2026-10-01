import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseCommandLine } from "@9thlevelsoftware/legion-cli-agents";
import {
  queryExperimentalVectorIndex,
  rebuildExperimentalVectorIndex,
  toFsPath,
} from "@9thlevelsoftware/legion-cli-persist";
import type { LegionConfig } from "@9thlevelsoftware/legion-cli-schema";
import {
  loadWikiPages,
  rankHybridRetrievalFromVectorResults,
  type SearchHit,
} from "@9thlevelsoftware/legion-cli-wiki";

type VectorFile = {
  documents: Array<{ id: string; vector: number[] }>;
  queries?: Record<string, number[]>;
};

function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

async function configuredVectors(projectRoot: string, path: string): Promise<VectorFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(toFsPath(projectRoot, path), "utf8"));
  } catch (err) {
    throw new Error(`hybrid retrieval vectorsPath could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const value = parsed as Partial<VectorFile>;
  if (!Array.isArray(value.documents) || value.documents.some((item) => !item || typeof item.id !== "string" || !validVector(item.vector))) {
    throw new Error("hybrid retrieval vectorsPath must contain documents [{id, vector}]");
  }
  if (value.queries !== undefined && (value.queries === null || typeof value.queries !== "object" || Array.isArray(value.queries))) {
    throw new Error("hybrid retrieval queries must map exact query text to vectors");
  }
  return value as VectorFile;
}

function localEmbedding(projectRoot: string, command: string, query: string): number[] {
  const parsed = parseCommandLine(command);
  if ("error" in parsed) throw new Error(`hybrid retrieval embeddingCommand: ${parsed.error}`);
  const [binary, ...args] = parsed.argv;
  if (!binary) throw new Error("hybrid retrieval embeddingCommand is empty");
  const result = spawnSync(binary, [...args, query], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: Object.fromEntries(
      ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "HOME", "USERPROFILE"]
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  });
  if (result.status !== 0) throw new Error(`hybrid retrieval embeddingCommand failed: ${result.stderr.trim() || result.error?.message || `exit ${result.status}`}`);
  let output: unknown;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new Error("hybrid retrieval embeddingCommand must print one JSON vector");
  }
  const vector = Array.isArray(output) ? output : (output as { vector?: unknown })?.vector;
  if (!validVector(vector)) throw new Error("hybrid retrieval embeddingCommand returned an invalid vector");
  return vector;
}

/** Explicit opt-in hybrid search over the rebuildable sqlite-vec index. */
export async function hybridSearch(
  projectRoot: string,
  query: string,
  lexical: readonly SearchHit[],
  config: LegionConfig["search"],
): Promise<SearchHit[]> {
  if (config.mode !== "hybrid") return [...lexical];
  if (!config.vectorsPath) throw new Error("hybrid retrieval requires search.vectorsPath");
  const vectors = await configuredVectors(projectRoot, config.vectorsPath);
  const queryVector = config.embeddingCommand
    ? localEmbedding(projectRoot, config.embeddingCommand, query)
    : vectors.queries?.[query];
  if (!queryVector) throw new Error("hybrid retrieval has no exact precomputed query vector and no embeddingCommand");
  const rebuilt = rebuildExperimentalVectorIndex(projectRoot, vectors.documents);
  if (!rebuilt.available) throw new Error(`hybrid retrieval unavailable: ${rebuilt.reason}`);
  const vectorResult = queryExperimentalVectorIndex(projectRoot, queryVector);
  if (!vectorResult.available) throw new Error(`hybrid retrieval unavailable: ${vectorResult.reason}`);

  const pages = loadWikiPages(projectRoot);
  const lexicalRank = new Map(lexical.map((hit, index) => [hit.id, lexical.length - index]));
  const ranked = rankHybridRetrievalFromVectorResults(
    pages.map((page) => ({
      id: page.id,
      path: page.path,
      title: page.title,
      trust: page.trust,
      lexicalScore: lexicalRank.get(page.id) ?? 0,
    })),
    { vectorResults: vectorResult.results },
  );
  const lexicalById = new Map(lexical.map((hit) => [hit.id, hit]));
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const hits = ranked.map((item): SearchHit => {
    const existing = lexicalById.get(item.id);
    if (existing) return existing;
    const page = pageById.get(item.id)!;
    return {
      id: page.id,
      path: page.path,
      title: page.title,
      trust: "reviewed",
      snippet: page.body.trim().slice(0, 180),
      via: "catalog",
    };
  });
  const exact = query.trim().toLowerCase();
  return hits.sort((a, b) => {
    const aExact = [a.id, a.title, a.path].some((value) => value.toLowerCase() === exact);
    const bExact = [b.id, b.title, b.path].some((value) => value.toLowerCase() === exact);
    return Number(bExact) - Number(aExact);
  });
}
