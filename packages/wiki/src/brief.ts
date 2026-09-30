import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  extractWikiLinks,
  indexDbUsable,
  type LegionReader,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  AssumptionSchema,
  FingerprintFileSchema,
  QAScoreSchema,
  SCHEMA_VERSION,
  SessionBriefSchema,
  type Assumption,
  type FileContract,
  type QAScore,
  type SessionBrief,
} from "@9thlevelsoftware/legion-cli-schema";
import { hubs, loadWikiBodies, loadWikiLinks, loadWikiPageHeads, type WikiPageHead } from "./graph.js";
import { twoLineSummary } from "./parser.js";

export const SESSION_BRIEF_CHAR_CAP = 24_000;

/** @internal Work counters for tests (assert bounded work, not wall time); not a stable API. */
export const briefCounters = { renders: 0, summaries: 0, bodiesLoaded: 0 };

export function resetBriefCounters(): void {
  briefCounters.renders = 0;
  briefCounters.summaries = 0;
  briefCounters.bodiesLoaded = 0;
}

async function listMarkdown(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((name) => name.toLowerCase().endsWith(".md"));
}

async function loadAssumptions(store: LegionReader): Promise<Assumption[]> {
  const files = await listMarkdown(store.paths.assumptionsDir);
  const out: Assumption[] = [];
  for (const file of files) {
    const id = file.replace(/\.md$/i, "");
    try {
      out.push((await store.readAssumption(id)).data);
    } catch {
      continue;
    }
  }
  return out;
}

async function loadAcceptedDecisions(
  store: LegionReader,
): Promise<Array<{ id: string; summary: string }>> {
  const files = await listMarkdown(store.paths.decisionsDir);
  const out: Array<{ id: string; summary: string; status: string }> = [];
  for (const file of files) {
    try {
      const doc = await store.readDecision(file);
      out.push({ id: doc.data.id, summary: doc.data.summary, status: doc.data.status });
    } catch {
      continue;
    }
  }
  return out
    .filter((row) => row.status === "accepted")
    .slice(0, 10)
    .map(({ id, summary }) => ({ id, summary }));
}

async function loadLastQa(store: LegionReader, lastQaId: string | null | undefined): Promise<{
  total: number;
  pass: boolean;
} | null> {
  if (!lastQaId) return null;
  try {
    const raw = JSON.parse(await readFile(join(store.paths.qaDir, "scores", `${lastQaId}.json`), "utf8")) as unknown;
    const score: QAScore = QAScoreSchema.parse(raw);
    return { total: score.total, pass: score.pass };
  } catch {
    return null;
  }
}

function wikiEntry(page: WikiPageHead, body: string): SessionBrief["wiki"][number] {
  if (page.trust === "untrusted") {
    return { path: page.path, title: page.title, summary: null, trust: "untrusted" };
  }
  briefCounters.summaries += 1;
  const summary = twoLineSummary(body);
  return {
    path: page.path,
    title: page.title,
    summary: summary.length > 0 ? summary : null,
    trust: "reviewed",
  };
}

/** Rendered length of a page line when its summary is dropped (the smallest a page can be). */
function minWikiLineLength(page: Pick<WikiPageHead, "title" | "path" | "trust">): number {
  const line = page.trust === "untrusted" ? `- ${page.title} (${page.path}) untrusted` : `- ${page.title} (${page.path})`;
  return line.length + 1;
}

function rankWikiPages(
  pages: WikiPageHead[],
  hubIds: Set<string>,
  specLinked: Set<string>,
): WikiPageHead[] {
  const score = (page: WikiPageHead): number => {
    if (hubIds.has(page.id)) return 0;
    if (specLinked.has(page.id) || [...specLinked].some((id) => page.id.endsWith(id) || id.endsWith(page.id))) {
      return 1;
    }
    if (page.trust === "untrusted") return 2;
    return 3;
  };
  return [...pages].sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
}

function wikiLines(page: SessionBrief["wiki"][number]): string[] {
  if (page.trust === "untrusted") return [`- ${page.title} (${page.path}) untrusted`];
  const lines = [`- ${page.title} (${page.path})`];
  if (page.summary) for (const summaryLine of page.summary.split("\n")) lines.push(`  ${summaryLine}`);
  return lines;
}

function wikiChunkLength(page: SessionBrief["wiki"][number]): number {
  let n = 0;
  for (const line of wikiLines(page)) n += line.length + 1;
  return n;
}

export function renderSessionBrief(brief: SessionBrief): string {
  const lines: string[] = [];
  lines.push(`Project: ${brief.project.name} (${brief.project.mode}, ${brief.project.controlMode})`);
  lines.push(`Phase: ${brief.phase}`);
  if (brief.currentTask) {
    const adapterBit = brief.currentTask.adapter ? ` (${brief.currentTask.adapter})` : "";
    lines.push(`Current task: ${brief.currentTask.id} ${brief.currentTask.title}${adapterBit}`);
  }
  if (brief.mapRootHash) {
    lines.push(`Map rootHash: ${brief.mapRootHash}`);
  }
  lines.push("");
  lines.push("Blocking assumptions:");
  if (brief.blockers.length === 0) {
    lines.push("- (none)");
  } else {
    for (const blocker of brief.blockers) {
      lines.push(`- ${blocker.id}: ${blocker.statement}`);
    }
  }
  lines.push("");
  lines.push("Decisions:");
  if (brief.decisions.length === 0) {
    lines.push("- (none)");
  } else {
    for (const decision of brief.decisions) {
      lines.push(`- ${decision.id}: ${decision.summary}`);
    }
  }
  if (brief.skills && brief.skills.length > 0) {
    lines.push("");
    lines.push("Skills:");
    for (const skill of brief.skills) {
      const active = skill.active ? " (active)" : "";
      const description = skill.description.trim();
      lines.push(description.length > 0 ? `- ${skill.name}${active}: ${description}` : `- ${skill.name}${active}`);
    }
  }
  lines.push("");
  lines.push("Wiki:");
  if (brief.wiki.length === 0) {
    lines.push("- (none)");
  } else {
    for (const page of brief.wiki) lines.push(...wikiLines(page));
  }
  if (brief.contract) {
    lines.push("");
    lines.push("FileContract:");
    lines.push(`  filesAllowed: ${brief.contract.filesAllowed.join(", ")}`);
    lines.push(`  verificationCommands: ${brief.contract.verificationCommands.join(", ")}`);
  }
  if (brief.lastQa) {
    lines.push("");
    lines.push(`Last QA: total ${brief.lastQa.total} pass=${brief.lastQa.pass}`);
  }
  lines.push("");
  lines.push("Closed task logs live in `.legion-cli/audit/`; do not reload them.");
  return `${lines.join("\n")}\n`;
}

function withCount(brief: Omit<SessionBrief, "characterCount">, rendered: string): SessionBrief {
  return SessionBriefSchema.parse({ ...brief, characterCount: rendered.length });
}

export function assembleSessionBrief(input: {
  project: SessionBrief["project"];
  phase: SessionBrief["phase"];
  currentTask?: SessionBrief["currentTask"];
  blockers: Assumption[];
  decisions: Array<{ id: string; summary: string }>;
  wiki: SessionBrief["wiki"];
  contract?: FileContract | null;
  lastQa?: SessionBrief["lastQa"];
  skills?: SessionBrief["skills"];
  mapRootHash?: string;
}): SessionBrief {
  const base = {
    schemaVersion: SCHEMA_VERSION.brief,
    project: input.project,
    phase: input.phase,
    currentTask: input.currentTask ?? null,
    blockers: input.blockers.slice(0, 5),
    decisions: input.decisions.slice(0, 10),
    contract: input.contract ?? null,
    lastQa: input.lastQa ?? null,
    ...(input.mapRootHash ? { mapRootHash: input.mapRootHash } : {}),
  };
  let wiki = input.wiki;
  let skills = input.skills;

  const snapshot = (): Omit<SessionBrief, "characterCount"> => ({
    ...base,
    wiki,
    ...(skills !== undefined ? { skills } : {}),
  });
  // Rendering never reads characterCount, so the schema is parsed once, at the end (withCount).
  const render = (): string => {
    briefCounters.renders += 1;
    return renderSessionBrief({ ...snapshot(), characterCount: 0 } as SessionBrief);
  };

  // Single pass: size the fixed part once (empty wiki renders "- (none)\n"), then pick the longest
  // wiki prefix that fits from running lengths instead of re-rendering after every dropped page.
  const EMPTY_WIKI_LEN = "- (none)\n".length;
  const wikiEmpty = wiki;
  wiki = [];
  const fixedLen = render().length - EMPTY_WIKI_LEN;
  wiki = wikiEmpty;
  const fit = (chunks: number[]): number => {
    let total = fixedLen;
    const prefix = [0];
    for (const n of chunks) {
      total += n;
      prefix.push(total);
    }
    let k = chunks.length;
    while (k > 0 && prefix[k]! > SESSION_BRIEF_CHAR_CAP) k -= 1;
    return k;
  };
  const fullChunks = wiki.map(wikiChunkLength);
  const fullTotal = fixedLen + (fullChunks.length === 0 ? EMPTY_WIKI_LEN : fullChunks.reduce((x, y) => x + y, 0));
  if (fullTotal > SESSION_BRIEF_CHAR_CAP) {
    wiki = wiki.map((page) => ({ ...page, summary: null }));
    wiki = wiki.slice(0, fit(wiki.map(wikiChunkLength)));
  }
  let rendered = render();
  if (rendered.length > SESSION_BRIEF_CHAR_CAP && skills && skills.length > 0) {
    skills = skills.map((skill) => ({ ...skill, description: "" }));
    rendered = render();
  }
  if (
    rendered.length > SESSION_BRIEF_CHAR_CAP &&
    skills &&
    skills.length > 0 &&
    skills.some((skill) => skill.active === true)
  ) {
    skills = skills.filter((skill) => skill.active === true);
    rendered = render();
  }
  return withCount(snapshot(), rendered);
}

export function wikiIndexReady(projectRoot: string): boolean {
  return indexDbUsable(projectRoot);
}

export async function ensureWikiIndex(
  store: LegionReader,
  opts?: { rebuild?: boolean },
): Promise<void> {
  if (wikiIndexReady(store.projectRoot)) return;
  if (opts?.rebuild === false) {
    throw new Error("run index rebuild");
  }
  const writable = store as LegionStore;
  if (typeof writable.rebuild !== "function") {
    throw new Error("run index rebuild");
  }
  await writable.rebuild();
}

async function readMapRootHash(store: LegionReader): Promise<string | undefined> {
  try {
    const dirSt = await lstat(store.paths.mapDir);
    if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  try {
    const parsed = FingerprintFileSchema.safeParse(
      JSON.parse(await readFile(join(store.paths.mapDir, "fingerprints.json"), "utf8")),
    );
    return parsed.success ? parsed.data.rootHash : undefined;
  } catch {
    return undefined;
  }
}

export async function buildSessionBrief(
  store: LegionReader,
  opts?: { rebuild?: boolean; skills?: SessionBrief["skills"]; mapRootHash?: string },
): Promise<SessionBrief> {
  await ensureWikiIndex(store, opts);
  const project = (await store.readProject()).data;
  const state = (await store.readState()).data;
  const blockers = (await loadAssumptions(store))
    .filter((assumption) => assumption.status === "open" && assumption.blocking)
    .slice(0, 5);
  const decisions = await loadAcceptedDecisions(store);

  let currentTask: SessionBrief["currentTask"] = null;
  let contract: FileContract | null = null;
  if (state.currentTaskId) {
    try {
      const task = (await store.readTask(state.currentTaskId)).data;
      currentTask = {
        id: task.id,
        title: task.title,
        ...(task.adapter ? { adapter: task.adapter } : {}),
      };
      contract = task.contract;
    } catch {
      currentTask = { id: state.currentTaskId, title: state.currentTaskId };
    }
  }

  const specLinked = new Set<string>();
  if (state.activeSpecId) {
    try {
      const spec = await store.readSpec(state.activeSpecId);
      for (const link of extractWikiLinks(spec.body)) specLinked.add(link);
    } catch {
      // no spec yet
    }
  }

  const pages = loadWikiPageHeads(store.projectRoot);
  const links = loadWikiLinks(store.projectRoot);
  const hubIds = new Set(hubs(links).map((row) => row.id));
  const ranked = rankWikiPages(pages, hubIds, specLinked);
  // Pages past the point where even summary-less lines overflow the cap can never be rendered:
  // read bodies (and summarise) only for the ranked head that can still fit.
  let minTotal = 0;
  let keep = 0;
  while (keep < ranked.length && minTotal <= SESSION_BRIEF_CHAR_CAP) {
    minTotal += minWikiLineLength(ranked[keep]!);
    keep += 1;
  }
  const head = ranked.slice(0, keep);
  const bodies = loadWikiBodies(
    store.projectRoot,
    head.filter((page) => page.trust !== "untrusted").map((page) => page.id),
  );
  briefCounters.bodiesLoaded += bodies.size;
  const wiki = head.map((page) => wikiEntry(page, bodies.get(page.id) ?? ""));
  const lastQa = await loadLastQa(store, state.lastQaId);

  return assembleSessionBrief({
    project: {
      name: project.name,
      mode: project.mode,
      controlMode: project.controlMode,
    },
    phase: state.phase,
    currentTask,
    blockers,
    decisions,
    wiki,
    contract,
    lastQa,
    skills: opts?.skills,
    mapRootHash: opts?.mapRootHash ?? (await readMapRootHash(store)),
  });
}
