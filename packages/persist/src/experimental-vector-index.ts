import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { legionPaths } from "./layout.js";
import { openIndexDb } from "./sqlite.js";

const require = createRequire(import.meta.url);
const VECTOR_TABLE = "legion_experimental_vectors";

export type ExperimentalVector = { id: string; vector: readonly number[] };
export type ExperimentalVectorResult = { id: string; distance: number };
export type ExperimentalVectorUnavailable = { available: false; reason: string };
export type ExperimentalVectorAvailability = { available: true } | ExperimentalVectorUnavailable;
export type ExperimentalVectorRebuildResult =
  | { available: true; count: number; dimensions: number }
  | ExperimentalVectorUnavailable;
export type ExperimentalVectorQueryResult =
  | { available: true; results: ExperimentalVectorResult[] }
  | ExperimentalVectorUnavailable;

function unavailable(reason: string): ExperimentalVectorUnavailable {
  return { available: false, reason };
}

function validVector(vector: readonly number[]): boolean {
  return vector.length > 0 && vector.every((value) => Number.isFinite(value));
}

function sqliteVecLoadablePath(): string | ExperimentalVectorUnavailable {
  try {
    const module = require("sqlite-vec") as { getLoadablePath?: unknown; loadablePath?: unknown };
    const resolvePath = typeof module.getLoadablePath === "function"
      ? module.getLoadablePath
      : typeof module.loadablePath === "function"
        ? module.loadablePath
        : undefined;
    if (!resolvePath) return unavailable("sqlite-vec does not expose a loadable extension");
    const path = resolvePath();
    return typeof path === "string" && path.length > 0
      ? path
      : unavailable("sqlite-vec did not provide a loadable extension");
  } catch {
    return unavailable("sqlite-vec platform extension is not installed");
  }
}

function loadExtension(db: SqliteDatabase): ExperimentalVectorAvailability {
  const loadablePath = sqliteVecLoadablePath();
  if (typeof loadablePath !== "string") return loadablePath;
  try {
    db.loadExtension(loadablePath);
    db.prepare("SELECT vec_version() AS version").get();
    return { available: true };
  } catch {
    return unavailable("sqlite-vec extension could not be loaded");
  }
}

function hasVectorTable(db: SqliteDatabase): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(VECTOR_TABLE) as { present?: number } | undefined;
  return row?.present === 1;
}

function vectorBlob(vector: readonly number[]): Buffer {
  const values = Float32Array.from(vector);
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function withExperimentalDb<T>(
  projectRoot: string,
  operation: (db: SqliteDatabase) => T,
): T | ExperimentalVectorUnavailable {
  const paths = legionPaths(projectRoot);
  try {
    mkdirSync(paths.indexDir, { recursive: true });
    const db = openIndexDb(paths.db);
    try {
      const availability = loadExtension(db);
      return availability.available ? operation(db) : availability;
    } finally {
      db.close();
    }
  } catch {
    return unavailable("sqlite-vec index could not be opened");
  }
}

/** Explicitly reports whether the optional sqlite-vec extension can load. */
export function experimentalVectorIndexAvailability(projectRoot: string): ExperimentalVectorAvailability {
  const result = withExperimentalDb(projectRoot, () => ({ available: true as const }));
  return result;
}

/**
 * Replaces the opt-in, rebuildable local vector table using supplied vectors.
 * No document content leaves the project and no embedding provider is invoked.
 */
export function rebuildExperimentalVectorIndex(
  projectRoot: string,
  vectors: readonly ExperimentalVector[],
): ExperimentalVectorRebuildResult {
  if (vectors.some((item) => !item.id || !validVector(item.vector))) {
    throw new RangeError("experimental vector index requires non-empty IDs and finite, non-empty vectors");
  }
  const dimensions = vectors[0]?.vector.length ?? 0;
  if (vectors.some((item) => item.vector.length !== dimensions)) {
    throw new RangeError("experimental vector index requires vectors with identical dimensions");
  }
  if (new Set(vectors.map((item) => item.id)).size !== vectors.length) {
    throw new RangeError("experimental vector index requires unique IDs");
  }
  const result = withExperimentalDb(projectRoot, (db) => {
    db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    if (dimensions > 0) {
      db.exec(`CREATE VIRTUAL TABLE ${VECTOR_TABLE} USING vec0(id TEXT PRIMARY KEY, embedding float[${dimensions}])`);
      const insert = db.prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`);
      const transaction = db.transaction(() => {
        for (const item of vectors) insert.run(item.id, vectorBlob(item.vector));
      });
      transaction();
    }
    return { available: true as const, count: vectors.length, dimensions };
  });
  return result;
}

/** Queries every local vector result, then applies a stable distance/ID order. */
export function queryExperimentalVectorIndex(
  projectRoot: string,
  queryVector: readonly number[],
  limit?: number,
): ExperimentalVectorQueryResult {
  if (!validVector(queryVector)) {
    throw new RangeError("experimental vector query requires a finite, non-empty vector");
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new RangeError("experimental vector query limit must be a positive integer");
  }
  const result = withExperimentalDb(projectRoot, (db) => {
    if (!hasVectorTable(db)) return unavailable("experimental vector index has not been rebuilt");
    try {
      const countRow = db.prepare(`SELECT count(*) AS count FROM ${VECTOR_TABLE}`).get() as { count: number };
      const rows = db.prepare(
        `SELECT id, distance FROM ${VECTOR_TABLE} WHERE embedding MATCH ? AND k = ?`,
      ).all(vectorBlob(queryVector), countRow.count) as ExperimentalVectorResult[];
      const results = rows
        .map((row) => ({ id: row.id, distance: Number(row.distance) }))
        .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id, "en", { sensitivity: "variant" }));
      return { available: true as const, results: limit === undefined ? results : results.slice(0, limit) };
    } catch {
      return unavailable("experimental vector query failed");
    }
  });
  return result;
}
