import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  gitWorktreeAdd,
  isGitRepo,
  PersistError,
  runPagePath,
  runResumePath,
  tryGitHead,
  WIKI_PAGE_SCHEMA_VERSION,
  wikiRunPagePath,
  worktreeStorePath,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  BrownfieldRunIdSchema,
  BrownfieldRunSchema,
  SCHEMA_VERSION,
  type BrownfieldRun,
} from "@9thlevelsoftware/legion-cli-schema";
import { HINT, refuse } from "./errors.js";
import type { BrownfieldOptions, BrownfieldResult, PromoteRunResult } from "./types.js";

export const BROWNFIELD_PAGES = [
  "intent.md",
  "assumptions.md",
  "architecture.md",
  "code.md",
  "analysis.md",
  "design.md",
] as const;

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

const SKIP_LEGION_CHILDREN = new Set(["index", "cache", "worktrees"]);

function nowIso(): string {
  return new Date().toISOString();
}

function newRunId(): string {
  return randomBytes(4).toString("hex");
}

function parseEffort(raw: number | undefined): 1 {
  const effort = raw ?? 1;
  if (!Number.isInteger(effort) || effort < 1 || effort > 5) {
    refuse("brownfield --effort must be 1–5", HINT.brownfield);
  }
  if (effort !== 1) {
    refuse("brownfield effort 2–5 is not implemented yet", HINT.brownfield);
  }
  return 1;
}

function parseRunId(raw: string): string {
  const parsed = BrownfieldRunIdSchema.safeParse(raw.trim().toLowerCase());
  if (!parsed.success) {
    refuse("brownfield run id must be 8 hex chars", HINT.brownfieldResume);
  }
  return parsed.data;
}

async function writeRunFile(projectRoot: string, storePath: string, body: string): Promise<void> {
  const abs = join(projectRoot, ...storePath.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  const normalized = body.endsWith("\n") ? body : `${body}\n`;
  await writeFile(abs, normalized, "utf8");
}

async function readRunResume(store: LegionStore, runId: string): Promise<BrownfieldRun> {
  const storePath = runResumePath(runId);
  if (!(await store.pathExists(storePath))) {
    refuse(`Cannot resume: run ${runId} not found`, HINT.brownfieldResume);
  }
  const abs = join(store.projectRoot, ...storePath.split("/"));
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(abs, "utf8"));
  } catch {
    refuse("Cannot resume: state file not found or invalid", HINT.brownfieldResume);
  }
  const parsed = BrownfieldRunSchema.safeParse(raw);
  if (!parsed.success || parsed.data.runId !== runId) {
    refuse("Cannot resume: state file not found or invalid", HINT.brownfieldResume);
  }
  return parsed.data;
}

async function writeRunResume(projectRoot: string, run: BrownfieldRun): Promise<void> {
  const storePath = runResumePath(run.runId);
  const abs = join(projectRoot, ...storePath.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

async function collectEvidence(projectRoot: string): Promise<{ layout: string[]; sources: string[] }> {
  const layout: string[] = [];
  const sources: string[] = [];

  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (layout.length + sources.length >= 80 || depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (layout.length + sources.length >= 80) return;
      if (entry.name === "." || entry.name === "..") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (rel === ".legion-cli" && SKIP_LEGION_CHILDREN.has(entry.name)) continue;
        if (depth === 0) layout.push(`${childRel}/`);
        await walk(join(dir, entry.name), childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (depth === 0) layout.push(childRel);
      if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|cs|php)$/i.test(entry.name) || childRel.startsWith("src/")) {
        sources.push(childRel);
      }
    }
  }

  await walk(projectRoot, "", 0);
  return { layout, sources };
}

async function readPackageHint(projectRoot: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      name?: unknown;
      description?: unknown;
    };
    const name = typeof raw.name === "string" ? raw.name : "";
    const description = typeof raw.description === "string" ? raw.description : "";
    return [name, description].filter((part) => part.length > 0).join(" — ");
  } catch {
    return "";
  }
}

function renderPages(input: {
  runId: string;
  name: string;
  context: string;
  execute: boolean;
  packageHint: string;
  layout: string[];
  sources: string[];
}): Record<(typeof BROWNFIELD_PAGES)[number], string> {
  const context = input.context.trim() || "(none)";
  const layout = input.layout.length > 0 ? input.layout.map((p) => `- ${p}`).join("\n") : "- (empty tree)";
  const sources =
    input.sources.length > 0 ? input.sources.map((p) => `- ${p}`).join("\n") : "- (no source files listed)";
  const pkg = input.packageHint || "(no package.json)";
  return {
    "intent.md": [
      "# Intent brief",
      "",
      `- **Run ID**: ${input.runId}`,
      `- **Project**: ${input.name}`,
      `- **Captured**: ${nowIso()}`,
      "- **Effort level**: 1",
      `- **Execute requested**: ${input.execute}`,
      "",
      "## User Goal",
      context,
      "",
      "## First principles",
      "Existing code is evidence, not ground truth. Effort 1 does not treat observed behavior as intent.",
      "",
      "## Success Criteria",
      "- [ ] Architecture and code evidence captured in this run",
      "- [ ] Improvement SPEC can be written from this run (promote first if the wiki should own it)",
      "",
      "## Out of scope (effort 1)",
      "- LSP / architecture fingerprints",
      "- Tests, security, and documentation specialists (effort 2+)",
      "",
    ].join("\n"),
    "assumptions.md": [
      "# Assumptions register",
      "",
      "## Summary",
      "- **Total assumptions**: 2",
      "- **Needs user confirmation**: 2",
      "",
      "### A-001",
      "- **Statement**: Observed behavior is the intended product contract",
      "- **Evidence**: repository layout (no LSP)",
      "- **Confidence**: low",
      "- **Status**: needs_confirmation",
      "- **Source**: [Architecture]",
      "- **Impact if wrong**: bug",
      "",
      "### A-002",
      "- **Statement**: Current source files represent the system the user can demo",
      "- **Evidence**: listed source paths",
      "- **Confidence**: medium",
      "- **Status**: provisional",
      "- **Source**: [Code]",
      "- **Impact if wrong**: suggestion",
      "",
    ].join("\n"),
    "architecture.md": [
      "# Architecture (effort 1)",
      "",
      "No LSP. Layout from directory evidence only.",
      "",
      `Package: ${pkg}`,
      "",
      "## Top-level",
      layout,
      "",
      "## First-principles ideal",
      "Reconstruct intended architecture from the demo and intent brief, then diff against this layout.",
      "",
    ].join("\n"),
    "code.md": [
      "# Code (effort 1)",
      "",
      "Source files treated as evidence, not ground truth.",
      "",
      sources,
      "",
    ].join("\n"),
    "analysis.md": [
      "# Brownfield analysis findings",
      "",
      "Effort 1: Architecture + Code only. No LSP.",
      "",
      "### Architecture Summary",
      `Top-level evidence (${input.layout.length} entries). Existing layering may be accidental.`,
      "",
      "### Code Summary",
      `${input.sources.length} source files listed as evidence.`,
      "",
      "### Assumptions Needing Confirmation",
      "- A-001 Observed behavior is the intended product contract",
      "",
    ].join("\n"),
    "design.md": [
      "# Improvement design",
      "",
      "Gaps from effort-1 architecture + code. Not a frozen SPEC.",
      "",
      "## Recommended next",
      "1. Confirm A-001 / A-002 (code is evidence).",
      `2. \`legion-cli run promote ${input.runId}\` if these pages should live in the wiki.`,
      "3. \`legion-cli spec\` for the improvement increment.",
      "",
      "## Execute isolation",
      input.execute
        ? "This run requested `--execute`: product writes go in a git worktree, not the main checkout."
        : "Add `--execute` later (`legion-cli brownfield --resume`) to isolate product writes in a git worktree.",
      "",
    ].join("\n"),
  };
}

async function writeAnalysisPages(
  projectRoot: string,
  runId: string,
  pages: Record<(typeof BROWNFIELD_PAGES)[number], string>,
): Promise<void> {
  for (const name of BROWNFIELD_PAGES) {
    await writeRunFile(projectRoot, runPagePath(runId, name), pages[name]);
  }
}

function toResult(run: BrownfieldRun): BrownfieldResult {
  return {
    runId: run.runId,
    effort: 1,
    execute: run.execute,
    phase: run.phase,
    pages: run.pages,
    worktreePath: run.worktreePath ?? null,
    promoted: run.promoted,
    resumePath: runResumePath(run.runId),
  };
}

async function ensureWorktree(store: LegionStore, run: BrownfieldRun): Promise<BrownfieldRun> {
  const head = tryGitHead(store.projectRoot);
  if (!head) {
    refuse("brownfield --execute requires a git commit (HEAD)", HINT.gitRepo);
  }
  const rel = worktreeStorePath(run.runId);
  const abs = join(store.projectRoot, ".legion-cli", "worktrees", run.runId);
  try {
    gitWorktreeAdd(store.projectRoot, abs, `brownfield/${run.runId}`);
  } catch (err) {
    if (err instanceof PersistError) {
      refuse(err.message, HINT.gitRepo);
    }
    throw err;
  }
  return {
    ...run,
    execute: true,
    phase: "complete",
    preSpawnRef: head,
    worktreePath: rel,
    pages: [...BROWNFIELD_PAGES],
  };
}

export async function runBrownfield(store: LegionStore, opts: BrownfieldOptions): Promise<BrownfieldResult> {
  const stateExists = await store.pathExists(".legion-cli/STATE.md");
  if (!stateExists) {
    refuse("brownfield is refused until init", HINT.init);
  }
  if (!isGitRepo(store.projectRoot)) {
    refuse("brownfield requires a git repository", HINT.gitRepo);
  }

  const project = (await store.readProject()).data;
  const executeRequested = Boolean(opts.execute);
  const context = (opts.context ?? "").trim();

  let run: BrownfieldRun;
  if (opts.resume) {
    const runId = parseRunId(opts.resume);
    run = await readRunResume(store, runId);
    if (run.effort !== 1) {
      refuse("brownfield effort 2–5 is not implemented yet", HINT.brownfield);
    }
    const wantExecute = run.execute || executeRequested;
    if (run.phase === "complete" && run.worktreePath && wantExecute) {
      return toResult(run);
    }
    if (run.phase === "complete" && !wantExecute) {
      refuse("Run already complete; start a new legion-cli brownfield invocation", HINT.brownfield);
    }
    run = {
      ...run,
      execute: wantExecute,
      context: run.context || context,
    };
  } else {
    const effort = parseEffort(opts.effort);
    const runId = opts.runId ? parseRunId(opts.runId) : newRunId();
    if (await store.pathExists(runResumePath(runId))) {
      refuse(`brownfield run ${runId} already exists`, HINT.brownfieldResume);
    }
    run = {
      schemaVersion: SCHEMA_VERSION.run,
      runId,
      effort,
      execute: executeRequested,
      phase: "analysis",
      preSpawnRef: tryGitHead(store.projectRoot) ?? "UNBORN",
      startedAt: nowIso(),
      worktreePath: null,
      promoted: false,
      pages: [...BROWNFIELD_PAGES],
      context,
    };
  }

  await mkdir(join(store.projectRoot, ".legion-cli", "runs", run.runId), { recursive: true });
  await writeRunResume(store.projectRoot, run);

  const evidence = await collectEvidence(store.projectRoot);
  const pages = renderPages({
    runId: run.runId,
    name: project.name,
    context: run.context,
    execute: run.execute,
    packageHint: await readPackageHint(store.projectRoot),
    layout: evidence.layout,
    sources: evidence.sources,
  });
  await writeAnalysisPages(store.projectRoot, run.runId, pages);
  run = { ...run, pages: [...BROWNFIELD_PAGES], phase: run.execute ? "execute" : "complete" };
  await writeRunResume(store.projectRoot, run);

  if (run.execute) {
    run = await ensureWorktree(store, run);
    await writeRunResume(store.projectRoot, run);
  }

  return toResult(run);
}

export async function promoteBrownfieldRun(store: LegionStore, runIdRaw: string): Promise<PromoteRunResult> {
  const stateExists = await store.pathExists(".legion-cli/STATE.md");
  if (!stateExists) {
    refuse("run promote is refused until init", HINT.init);
  }
  const runId = parseRunId(runIdRaw);
  const run = await readRunResume(store, runId);
  const copied: string[] = [];
  for (const name of run.pages) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const sourceStore = runPagePath(runId, name);
    if (!(await store.pathExists(sourceStore))) continue;
    const abs = join(store.projectRoot, ...sourceStore.split("/"));
    const body = await readFile(abs, "utf8");
    const dest = wikiRunPagePath(runId, name);
    const title = name.replace(/\.md$/i, "");
    await store.writeWikiPage(
      dest,
      {
        schemaVersion: WIKI_PAGE_SCHEMA_VERSION,
        title: `Brownfield ${runId} ${title}`,
        aliases: [],
        tags: ["brownfield", "run"],
        trust: "reviewed",
        updated: nowIso(),
        source: sourceStore,
      },
      body,
    );
    copied.push(dest);
  }
  if (copied.length === 0) {
    refuse(`run ${runId} has no markdown pages to promote`, HINT.brownfield);
  }
  await writeRunResume(store.projectRoot, { ...run, promoted: true });
  await store.rebuild();
  return { runId, pages: copied };
}
