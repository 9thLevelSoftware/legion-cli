# Hybrid retrieval experiment

`@9thlevelsoftware/legion-cli-wiki` exposes `rankHybridRetrieval` and
`benchmarkHybridRetrieval` as an opt-in experiment. `legion-cli search` uses
the hybrid path only when `.legion-cli/config.yaml` explicitly sets
`search.mode: hybrid`; briefing remains lexical.

The experiment accepts a caller-owned lexical candidate set and explicitly
supplied, precomputed vectors. It removes every untrusted candidate before
ranking, orders lexical and cosine-similarity ties by ID, and combines the two
rankings with fixed reciprocal-rank fusion. It does not send content to an
embedding provider. `rankHybridRetrievalFromVectorResults` accepts the result
shape from the opt-in persist sqlite-vec index, and
`rankHybridRetrievalWithLocalEmbeddings` accepts an explicitly supplied local
embedding callback.

The benchmark helper evaluates a fixed caller-provided corpus. It reports mean
reciprocal rank for lexical and hybrid rankings, local elapsed time, and this
installation boundary:

| Item | Fixture result |
| --- | --- |
| Vector mode | precomputed vectors or a local callback |
| Added runtime dependency | no new required dependency |
| sqlite-vec | optional; explicitly loaded by persist |
| Local embeddings | supplied by the operator |

## Captured fixed repository-question corpus result

The focused test owns `tracked-repository-question-fixture-v1`, a fixed corpus
of five queries and expected IDs grounded in tracked pages. It copies each
tracked body into a reviewed temporary wiki index, calls the existing
`searchWiki` BM25 path, and derives lexical ranks only from that returned order.
No test-supplied lexical score or preferred ordering participates in the
measurement.

| Question | BM25 query phrase | Expected ID | Tracked page |
| --- | --- | --- | --- |
| What is the local-first CLI called? | `Legion CLI` | `benchmark/readme` | `README.md` |
| Which document defines the product lifecycle engine? | `Product Engineering lifecycle engine` | `benchmark/product-design` | `docs/design/product-engineering-cli.md` |
| Where are adapter routes described? | `Adapter routing` | `benchmark/adapter-routing` | `docs/design/adapter-routing.md` |
| What product does the fixture project describe? | `office check-in` | `benchmark/fixture-project` | `packages/persist/test/fixtures/project/legion-cli/PROJECT.md` |
| Which interface comes first for the fixture product? | `Phone first` | `benchmark/fixture-context` | `packages/persist/test/fixtures/project/legion-cli/CONTEXT.md` |

The fixture vectors are exact five-dimensional unit vectors declared in
`packages/wiki/test/experimental-hybrid.test.js`; each question uses the unit
vector assigned to its expected page. This makes the vectors reproducible
without an embedding service, but they are synthetic fixture data rather than
model output. A local capture on 2026-09-30 produced:

```json
{
  "corpus": "tracked-repository-question-fixture-v1",
  "cases": 5,
  "lexicalMeanReciprocalRank": 1.0,
  "hybridMeanReciprocalRank": 1.0,
  "lexicalSearchLatencyMs": 117.3104,
  "lexicalRankingOnlyLatencyMs": 0.0691,
  "hybridIncrementalRankingLatencyMs": 0.1965,
  "rankingOnlyCombinedLatencyMs": 0.2656,
  "sqliteVec": { "available": true }
}
```

`lexicalSearchLatencyMs` measures the five real `searchWiki`/BM25 calls,
including index reads and result construction. The remaining timing fields are
only the in-memory `benchmarkHybridRetrieval` sorting/fusion helper; they are
not a second measurement of BM25 search time.

The BM25 result was already rank one for every corpus query, so this fixture
measured parity rather than a hybrid relevance gain. The optional sqlite-vec
availability result is separate installation evidence from the persist vector
fixture, which rebuilt and queried a local three-vector table successfully.

The sqlite-vec fixture rebuilds three vectors and confirms a deterministic
distance/ID result order. If sqlite-vec or its platform extension is absent,
the same API returns `{ available: false, reason }`; it never reports a vector
check as passing.

This is fixture-only validation: it does not establish retrieval quality on a
live repository or validate an embedding model. The precomputed vectors cannot
support a claim about embedding quality. Latency is a local capture, not a
performance target.

Persist now provides an opt-in rebuildable sqlite-vec table in the existing
local index database. It only accepts precomputed vectors and never invokes an
embedding provider. The default `search` and brief paths remain lexical;
hybrid retrieval is selected only when `search.mode=hybrid` is explicitly
configured, and it retains the existing trust filtering.

The configured `vectorsPath` is a project-relative JSON file with
`documents: [{"id":"...","vector":[...]}]` and optional exact
`queries: {"question text":[...]}` entries. When `embeddingCommand` is set,
Legion invokes that local argv-only command with the query as its final
argument and expects one JSON vector (or `{ "vector": [...] }`) on stdout.
The subprocess receives only a minimal OS/PATH environment, has a 30-second
timeout and a 1 MiB output cap. No embedding or model is downloaded by Legion.
