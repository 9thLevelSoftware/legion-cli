/**
 * Opt-in retrieval experiment. This module deliberately has no database or
 * embedding-provider dependency: callers supply vectors from a local index.
 */
export type ExperimentalRetrievalCandidate = {
  id: string;
  path: string;
  title: string;
  trust: "untrusted" | "reviewed";
  /** Larger scores represent a stronger lexical match. */
  lexicalScore: number;
  /** A precomputed local embedding. No embedding request is made here. */
  vector?: readonly number[];
};

export type HybridRetrievalHit = ExperimentalRetrievalCandidate & {
  lexicalRank: number;
  vectorRank: number | null;
  vectorSimilarity: number | null;
  score: number;
};

export type HybridRetrievalOptions = {
  queryVector: readonly number[];
  /** Reciprocal-rank constant. The fixed default avoids query-dependent tuning. */
  reciprocalRankConstant?: number;
  lexicalWeight?: number;
  vectorWeight?: number;
};

/** Structural compatibility with persist's opt-in sqlite-vec query result. */
export type ExperimentalVectorSearchResult = { id: string; distance: number };

export type HybridVectorResultOptions = Omit<HybridRetrievalOptions, "queryVector"> & {
  vectorResults: readonly ExperimentalVectorSearchResult[];
};

export type HybridLocalEmbeddingOptions = Omit<HybridRetrievalOptions, "queryVector"> & {
  queryText: string;
  /** Caller-owned local embedding callback; this package makes no provider request. */
  embed: (input: { kind: "query" | "candidate"; text: string; id?: string }) => readonly number[];
};

const DEFAULT_RRF_CONSTANT = 60;
const DEFAULT_LEXICAL_WEIGHT = 1;
const DEFAULT_VECTOR_WEIGHT = 2;

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "variant" });
}

function compareByScoreThenId<T extends { id: string }>(
  a: T,
  b: T,
  score: (value: T) => number,
): number {
  const difference = score(b) - score(a);
  return difference !== 0 ? difference : compareText(a.id, b.id);
}

function validVector(vector: readonly number[]): boolean {
  return vector.length > 0 && vector.every((value) => Number.isFinite(value));
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (!validVector(a) || !validVector(b) || a.length !== b.length) {
    throw new RangeError("experimental hybrid retrieval requires equal, finite, non-empty vectors");
  }
  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aMagnitude += a[index] * a[index];
    bMagnitude += b[index] * b[index];
  }
  if (aMagnitude === 0 || bMagnitude === 0) {
    throw new RangeError("experimental hybrid retrieval does not accept zero-length vectors");
  }
  return dot / Math.sqrt(aMagnitude * bMagnitude);
}

/**
 * Fuses supplied lexical and vector rankings with deterministic reciprocal-rank
 * fusion. Only reviewed candidates participate; standard wiki search remains
 * the production retrieval path.
 */
export function rankHybridRetrieval(
  candidates: readonly ExperimentalRetrievalCandidate[],
  options: HybridRetrievalOptions,
): HybridRetrievalHit[] {
  if (!validVector(options.queryVector)) {
    throw new RangeError("experimental hybrid retrieval requires a finite, non-empty query vector");
  }
  const constant = options.reciprocalRankConstant ?? DEFAULT_RRF_CONSTANT;
  const lexicalWeight = options.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT;
  const vectorWeight = options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
  if (!Number.isFinite(constant) || constant < 0 || !Number.isFinite(lexicalWeight) || !Number.isFinite(vectorWeight)) {
    throw new RangeError("experimental hybrid retrieval weights must be finite and the rank constant non-negative");
  }

  const reviewed = candidates.filter((candidate) => candidate.trust === "reviewed");
  for (const candidate of reviewed) {
    if (!Number.isFinite(candidate.lexicalScore)) {
      throw new RangeError(`experimental hybrid retrieval received a non-finite lexical score for ${candidate.id}`);
    }
    if (candidate.vector && !validVector(candidate.vector)) {
      throw new RangeError(`experimental hybrid retrieval received an invalid vector for ${candidate.id}`);
    }
  }

  const semantic = reviewed
    .filter((candidate): candidate is ExperimentalRetrievalCandidate & { vector: readonly number[] } => candidate.vector !== undefined)
    .map((candidate) => ({ candidate, similarity: cosineSimilarity(options.queryVector, candidate.vector) }))
    .sort((a, b) => {
      const difference = b.similarity - a.similarity;
      return difference !== 0 ? difference : compareText(a.candidate.id, b.candidate.id);
    });
  const vectorRanks = new Map(semantic.map(({ candidate }, index) => [candidate.id, index + 1]));
  const similarities = new Map(semantic.map(({ candidate, similarity }) => [candidate.id, similarity]));

  return rankWithVectorRanks(reviewed, vectorRanks, similarities, options);
}

function rankWithVectorRanks(
  candidates: readonly ExperimentalRetrievalCandidate[],
  vectorRanks: ReadonlyMap<string, number>,
  similarities: ReadonlyMap<string, number | null>,
  options: Omit<HybridRetrievalOptions, "queryVector">,
): HybridRetrievalHit[] {
  const constant = options.reciprocalRankConstant ?? DEFAULT_RRF_CONSTANT;
  const lexicalWeight = options.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT;
  const vectorWeight = options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
  if (!Number.isFinite(constant) || constant < 0 || !Number.isFinite(lexicalWeight) || !Number.isFinite(vectorWeight)) {
    throw new RangeError("experimental hybrid retrieval weights must be finite and the rank constant non-negative");
  }
  const lexical = [...candidates].sort((a, b) => compareByScoreThenId(a, b, (candidate) => candidate.lexicalScore));
  const lexicalRanks = new Map(lexical.map((candidate, index) => [candidate.id, index + 1]));

  return candidates
    .map((candidate) => {
      const lexicalRank = lexicalRanks.get(candidate.id)!;
      const vectorRank = vectorRanks.get(candidate.id) ?? null;
      const score = (lexicalWeight / (constant + lexicalRank))
        + (vectorRank === null ? 0 : vectorWeight / (constant + vectorRank));
      return { ...candidate, lexicalRank, vectorRank, vectorSimilarity: similarities.get(candidate.id) ?? null, score };
    })
    .sort((a, b) => compareByScoreThenId(a, b, (hit) => hit.score));
}

/**
 * Fuses lexical candidates with results returned by persist's optional local
 * sqlite-vec index. Results for unknown or untrusted IDs never participate.
 */
export function rankHybridRetrievalFromVectorResults(
  candidates: readonly ExperimentalRetrievalCandidate[],
  options: HybridVectorResultOptions,
): HybridRetrievalHit[] {
  const reviewed = candidates.filter((candidate) => candidate.trust === "reviewed");
  const known = new Set(reviewed.map((candidate) => candidate.id));
  const vectorResults = options.vectorResults
    .filter((result) => known.has(result.id) && Number.isFinite(result.distance))
    .sort((a, b) => a.distance - b.distance || compareText(a.id, b.id));
  const vectorRanks = new Map<string, number>();
  const similarities = new Map<string, number | null>();
  for (const [index, result] of vectorResults.entries()) {
    if (!vectorRanks.has(result.id)) {
      vectorRanks.set(result.id, index + 1);
      similarities.set(result.id, null);
    }
  }
  return rankWithVectorRanks(reviewed, vectorRanks, similarities, options);
}

/** Uses an explicitly configured synchronous local embedding callback. */
export function rankHybridRetrievalWithLocalEmbeddings(
  candidates: readonly ExperimentalRetrievalCandidate[],
  options: HybridLocalEmbeddingOptions,
): HybridRetrievalHit[] {
  const queryVector = options.embed({ kind: "query", text: options.queryText });
  const embedded = candidates.map((candidate) => ({
    ...candidate,
    vector: candidate.trust === "reviewed"
      ? options.embed({ kind: "candidate", id: candidate.id, text: `${candidate.title}\n${candidate.path}` })
      : undefined,
  }));
  return rankHybridRetrieval(embedded, { ...options, queryVector });
}

export type FixedCorpusRetrievalCase = {
  /** Human-readable repository question retained by the caller's fixed corpus. */
  question?: string;
  queryVector: readonly number[];
  expectedId: string;
  candidates: readonly ExperimentalRetrievalCandidate[];
};

export type HybridRetrievalBenchmark = {
  cases: number;
  lexical: { reciprocalRank: number };
  hybrid: { reciprocalRank: number };
  lexicalLatencyMs: number;
  hybridLatencyMs: number;
  /** Combined local benchmark elapsed time, retained for simple consumers. */
  latencyMs: number;
  install: {
    mode: "precomputed-vectors";
    dependency: "none";
    sqliteVec: "not-required";
    localEmbeddings: "operator-supplied";
  };
};

function reciprocalRank(ids: readonly string[], expectedId: string): number {
  const position = ids.indexOf(expectedId);
  return position === -1 ? 0 : 1 / (position + 1);
}

/** Runs a caller-owned fixed corpus; it does not fetch models or install sqlite-vec. */
export function benchmarkHybridRetrieval(input: { cases: readonly FixedCorpusRetrievalCase[] }): HybridRetrievalBenchmark {
  const lexicalStartedAt = performance.now();
  let lexicalTotal = 0;
  for (const item of input.cases) {
    const reviewed = item.candidates.filter((candidate) => candidate.trust === "reviewed");
    const lexical = [...reviewed]
      .sort((a, b) => compareByScoreThenId(a, b, (candidate) => candidate.lexicalScore))
      .map((candidate) => candidate.id);
    lexicalTotal += reciprocalRank(lexical, item.expectedId);
  }
  const lexicalLatencyMs = performance.now() - lexicalStartedAt;
  const hybridStartedAt = performance.now();
  let hybridTotal = 0;
  for (const item of input.cases) {
    const hybrid = rankHybridRetrieval(item.candidates, { queryVector: item.queryVector }).map((candidate) => candidate.id);
    hybridTotal += reciprocalRank(hybrid, item.expectedId);
  }
  const hybridLatencyMs = performance.now() - hybridStartedAt;
  const divisor = input.cases.length;
  return {
    cases: divisor,
    lexical: { reciprocalRank: divisor === 0 ? 0 : lexicalTotal / divisor },
    hybrid: { reciprocalRank: divisor === 0 ? 0 : hybridTotal / divisor },
    lexicalLatencyMs,
    hybridLatencyMs,
    latencyMs: lexicalLatencyMs + hybridLatencyMs,
    install: {
      mode: "precomputed-vectors",
      dependency: "none",
      sqliteVec: "not-required",
      localEmbeddings: "operator-supplied",
    },
  };
}
