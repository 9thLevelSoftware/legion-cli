import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureGitignore,
  runResumePath,
  tryGitBranch,
  tryGitHead,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";
import { SCHEMA_VERSION, type BrownfieldRun, type BrownfieldSize } from "@9thlevelsoftware/legion-cli-schema";
import { HINT, refuse } from "../errors.js";
import type {
  BrownfieldAnalysisOutputStatus,
  BrownfieldArtifactPaths,
  BrownfieldEffort,
  BrownfieldInitResult,
  BrownfieldOptions,
  BrownfieldResult,
  BrownfieldStateResult,
} from "../types.js";
import type { MapResult } from "../map.js";
import { readDag, summarizeDag } from "./dag.js";
import { section, splitBlocks } from "./markdown.js";
import { RUN_SUBDIRS, runAbs, runArtifactPaths, storeAbs } from "./paths.js";
import {
  applyStateSet,
  assertBrownfieldReady,
  newRunId,
  nowIso,
  parseEffort,
  parseKeyValuePairs,
  parseRunId,
  readRun,
  writeRun,
} from "./state.js";

/** Tier → guidance that keeps process cost proportional to the codebase. */
export const SIZE_TIERS: { limit: number; tier: BrownfieldSize["tier"]; maxPrs: number; suggestedEffortMax: number }[] = [
  { limit: 1_500, tier: "tiny", maxPrs: 3, suggestedEffortMax: 2 },
  { limit: 15_000, tier: "small", maxPrs: 6, suggestedEffortMax: 3 },
  { limit: 150_000, tier: "medium", maxPrs: 10, suggestedEffortMax: 5 },
  { limit: Number.POSITIVE_INFINITY, tier: "large", maxPrs: 12, suggestedEffortMax: 5 },
];

const SKIP_PARTS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".next",
  ".legion-cli",
  ".brownfield",
  "coverage",
]);

/** Docs, data, lockfiles, and binaries do not count toward the code-size tier. */
const SKIP_SUFFIX =
  /\.(lock|min\.js|map|svg|png|jpe?g|gif|ico|pdf|woff2?|ttf|eot|zip|gz|tgz|jar|exe|dll|so|dylib|md|mdx|txt|rst|json|ya?ml|toml|csv|tsv|xml|ini|cfg|env|snap)$/i;
const SKIP_BASENAMES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Cargo.lock", "poetry.lock", "go.sum"]);

export function tierFor(lines: number): Omit<BrownfieldSize, "files" | "lines"> {
  const tier = SIZE_TIERS.find((candidate) => lines < candidate.limit) ?? SIZE_TIERS[SIZE_TIERS.length - 1];
  return { tier: tier.tier, maxPrs: tier.maxPrs, suggestedEffortMax: tier.suggestedEffortMax };
}

export function countsTowardSize(relPosix: string): boolean {
  const parts = relPosix.split("/");
  if (parts.some((part) => SKIP_PARTS.has(part))) return false;
  const name = parts[parts.length - 1] ?? "";
  // Dotfiles (.gitignore, .editorconfig, .env.example) are configuration, not code.
  return !name.startsWith(".") && !SKIP_BASENAMES.has(name) && !SKIP_SUFFIX.test(name);
}

/** Line count of tracked code files (git ls-files). Files over 2 MB are skipped. */
export async function measureRepo(projectRoot: string): Promise<BrownfieldSize> {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = listed.status === 0 ? String(listed.stdout).split("\0").filter(Boolean) : [];
  let count = 0;
  let lines = 0;
  for (const rel of files) {
    if (!countsTowardSize(rel)) continue;
    const abs = join(projectRoot, ...rel.split("/"));
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > 2_000_000) continue;
      const buf = await readFile(abs);
      if (buf.includes(0)) continue;
      let n = 0;
      for (const byte of buf) if (byte === 10) n += 1;
      lines += n;
      count += 1;
    } catch {
      continue;
    }
  }
  return { files: count, lines, ...tierFor(lines) };
}

async function analysisStatus(abs: string): Promise<BrownfieldAnalysisOutputStatus> {
  if (!existsSync(abs)) return "missing";
  try {
    const text = await readFile(abs, "utf8");
    const blocks = [
      ...splitBlocks(section(text, "Findings") || section(text, "Issues")),
      ...splitBlocks(section(text, "Assumptions")),
    ];
    return blocks.length > 0 ? "present" : "empty";
  } catch {
    return "missing";
  }
}

/** Deterministic "where to continue" for the orchestrating agent. */
export function nextStepFor(
  run: BrownfieldRun,
  artifacts: Record<string, boolean>,
  analysisOutputs: Record<string, BrownfieldAnalysisOutputStatus>,
  dag: BrownfieldStateResult["dag"],
): string {
  const id = run.runId;
  const pending = Object.entries(analysisOutputs)
    .filter(([, status]) => status !== "present")
    .map(([name, status]) => `${name} (${status})`);
  switch (run.phase) {
    case "intent":
      return artifacts.intent
        ? `legion-cli brownfield roster ${id}`
        : `write ${runArtifactPaths(id).intent} (goal, axioms FP-n, success criteria), then legion-cli brownfield roster ${id}`;
    case "plan":
      if (!run.roster) return `legion-cli brownfield roster ${id}`;
      return artifacts.plan
        ? `launch pass 1 specialists (${run.roster.pass1.join(", ")}); optionally legion-cli brownfield evidence ${id}`
        : `write ${runArtifactPaths(id).plan}, then launch pass 1 specialists (${run.roster.pass1.join(", ")})`;
    case "analysis":
      return pending.length > 0
        ? `specialist outputs not ready: ${pending.join(", ")}; relaunch those, then legion-cli brownfield merge ${id}`
        : `legion-cli brownfield merge ${id}`;
    case "assumptions":
      return `resolve blocking assumptions in assumptions.md, then legion-cli brownfield state ${id} phase=design`;
    case "design":
      return artifacts.design
        ? `launch the design reviewer, then legion-cli brownfield review-status ${id}`
        : `launch the design writer (design.md + summary.md), then the reviewer`;
    case "review":
      return `legion-cli brownfield review-status ${id}`;
    case "present":
      return run.execute ? `legion-cli brownfield pr-plan ${id}` : `legion-cli run promote ${id}`;
    case "execute":
      if (!dag?.present) return `legion-cli brownfield pr-plan ${id}`;
      if (dag.done) return `verify the combined result, then legion-cli brownfield state ${id} phase=verify`;
      return dag.ready.length > 0
        ? `legion-cli brownfield worktree ${id} ${dag.ready[0]} (ready: ${dag.ready.join(", ")})`
        : `legion-cli brownfield dag ${id} (nodes in flight)`;
    case "verify":
      return artifacts.verify
        ? `legion-cli brownfield state ${id} phase=complete`
        : `write ${runArtifactPaths(id).verify}, then legion-cli brownfield state ${id} phase=complete`;
    case "complete":
      if (run.execute && !dag?.present) return `legion-cli brownfield pr-plan ${id}`;
      return `legion-cli brownfield patterns --add "<lesson>" ...; legion-cli run promote ${id}`;
  }
}

/**
 * Start a run. `runMap` refreshes the codebase map after validation and before anything is
 * written, so a failed map (e.g. `--lsp` with no language server) leaves no half-made run.
 */
export async function initRun(
  store: LegionStore,
  opts: BrownfieldOptions,
  runMap: () => Promise<MapResult>,
): Promise<BrownfieldInitResult> {
  await assertBrownfieldReady(store);
  const effort = parseEffort(opts.effort);
  const runId = opts.runId ? parseRunId(opts.runId) : newRunId();
  if (await store.pathExists(runResumePath(runId))) {
    refuse(`brownfield run ${runId} already exists`, HINT.brownfieldResume);
  }
  const root = store.projectRoot;
  const head = tryGitHead(root);
  const execute = Boolean(opts.execute);
  if (execute && !head) {
    refuse("brownfield --execute requires a git commit (HEAD)", HINT.gitRepo);
  }
  const map = await runMap();
  for (const dir of RUN_SUBDIRS) await mkdir(runAbs(root, runId, dir), { recursive: true });
  await ensureGitignore(root);
  const size = await measureRepo(root);
  const warnings: string[] = [];
  if (effort > size.suggestedEffortMax) {
    warnings.push(
      `${size.tier} repo (${size.lines} code lines): effort ${effort} exceeds the suggested max ${size.suggestedEffortMax}; running as asked`,
    );
  }
  const run = await writeRun(root, {
    schemaVersion: SCHEMA_VERSION.run,
    runId,
    effort,
    execute,
    phase: "intent",
    preSpawnRef: head ?? "UNBORN",
    startedAt: nowIso(),
    worktreePath: null,
    promoted: false,
    pages: [],
    context: (opts.context ?? "").trim(),
    size,
    designReviewRounds: 0,
    assumptionRounds: 0,
    baseBranch: tryGitBranch(root),
    meta: { map: { backend: map.backend, modules: map.modules, path: map.path } },
  });
  return {
    kind: "init",
    runId,
    effort,
    execute,
    phase: run.phase,
    size,
    baseBranch: run.baseBranch,
    preSpawnRef: run.preSpawnRef,
    paths: runArtifactPaths(runId),
    resumePath: runResumePath(runId),
    map,
    warnings,
    next: nextStepFor(run, { intent: false }, {}, null),
  };
}

async function artifactPresence(projectRoot: string, paths: BrownfieldArtifactPaths): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const key of ["intent", "plan", "findings", "assumptions", "design", "summary", "designReview", "dag", "verify"] as const) {
    out[key] = existsSync(storeAbs(projectRoot, paths[key]));
  }
  return out;
}

export async function stateRun(
  store: LegionStore,
  runId: string,
  pairs: readonly string[] = [],
): Promise<BrownfieldStateResult> {
  await assertBrownfieldReady(store);
  let run = await readRun(store, runId);
  if (pairs.length > 0) {
    const hint = HINT.brownfieldState(runId);
    run = await writeRun(store.projectRoot, applyStateSet(run, parseKeyValuePairs(pairs, hint), hint));
  }
  const paths = runArtifactPaths(runId);
  const artifacts = await artifactPresence(store.projectRoot, paths);
  const analysisOutputs: Record<string, BrownfieldAnalysisOutputStatus> = {};
  for (const specialist of [...(run.roster?.pass1 ?? []), ...(run.roster?.pass2 ?? [])]) {
    analysisOutputs[specialist] = await analysisStatus(runAbs(store.projectRoot, runId, "analysis", `${specialist}.md`));
  }
  let dag: BrownfieldStateResult["dag"] = null;
  if (artifacts.dag) {
    const summary = summarizeDag(await readDag(store.projectRoot, runId));
    dag = { present: true, done: summary.done, ready: summary.ready };
  }
  return {
    kind: "state",
    runId,
    state: run,
    paths,
    artifacts,
    analysisOutputs,
    dag,
    next: nextStepFor(run, artifacts, analysisOutputs, dag),
  };
}

/** `brownfield --resume <id>`: optionally switch on execute, then report state and where to continue. */
export async function resumeRun(store: LegionStore, runIdRaw: string, opts: BrownfieldOptions): Promise<BrownfieldStateResult> {
  await assertBrownfieldReady(store);
  const runId = parseRunId(runIdRaw);
  const run = await readRun(store, runId);
  if (opts.effort !== undefined && opts.effort !== run.effort) {
    refuse(`brownfield run ${runId} cannot change effort (stored ${run.effort})`, HINT.brownfieldResume);
  }
  if (opts.execute && !run.execute) {
    if (!tryGitHead(store.projectRoot)) {
      refuse("brownfield --execute requires a git commit (HEAD)", HINT.gitRepo);
    }
    await writeRun(store.projectRoot, { ...run, execute: true });
  }
  return stateRun(store, runId);
}

export async function brownfieldEntry(
  store: LegionStore,
  opts: BrownfieldOptions,
  runMap: () => Promise<MapResult>,
): Promise<BrownfieldResult> {
  if (opts.resume) return resumeRun(store, opts.resume, opts);
  return initRun(store, opts, runMap);
}

export type { BrownfieldEffort };
