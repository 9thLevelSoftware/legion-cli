import { join } from "node:path";
import { runPagePath, runResumePath, runStorePath, toFsPath } from "@9thlevelsoftware/legion-cli-persist";
import type { BrownfieldArtifactPaths } from "../types.js";

/** Subdirectories every run gets at init. `analysis/` is specialist output only; `merge` reads nothing else. */
export const RUN_SUBDIRS = ["analysis", "reviews", "evidence", "exec"] as const;

export const DAG_FILE = "dag.json";

/** Project-level cross-run lessons (not per run). */
export const PATTERNS_STORE_PATH = ".legion-cli/runs/patterns.json";

export function runArtifactPaths(runId: string): BrownfieldArtifactPaths {
  const page = (name: string) => runPagePath(runId, name);
  return {
    runDir: runStorePath(runId),
    state: runResumePath(runId),
    intent: page("intent.md"),
    plan: page("plan.md"),
    analysisDir: page("analysis"),
    findings: page("findings.md"),
    assumptions: page("assumptions.md"),
    design: page("design.md"),
    summary: page("summary.md"),
    reviewsDir: page("reviews"),
    designReview: page("reviews/design-review.md"),
    dag: page(DAG_FILE),
    evidenceDir: page("evidence"),
    execDir: page("exec"),
    verify: page("verify.md"),
  };
}

/** Absolute filesystem path for a POSIX store path. Absolute or escaping paths throw `PathEscapeError`. */
export function storeAbs(projectRoot: string, storePath: string): string {
  return toFsPath(projectRoot, storePath);
}

/** Absolute path inside a run directory. */
export function runAbs(projectRoot: string, runId: string, ...rel: string[]): string {
  return join(storeAbs(projectRoot, runStorePath(runId)), ...rel.flatMap((part) => part.split("/")));
}
