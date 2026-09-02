import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  extractWikiLinks,
  queryIndex,
  type LegionStore,
} from "@9thlevelsoftware/legion-cli-persist";
import {
  AssumptionSchema,
  QAScoreSchema,
  SCHEMA_VERSION,
  SessionBriefSchema,
  type Assumption,
  type FileContract,
  type QAScore,
  type SessionBrief,
} from "@9thlevelsoftware/legion-cli-schema";
import { hubs, loadWikiLinks, loadWikiPages, type WikiPageRow } from "./graph.js";
import { twoLineSummary } from "./parser.js";

export const SESSION_BRIEF_CHAR_CAP = 24_000;

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

async function loadAssumptions(store: LegionStore): Promise<Assumption[]> {
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
  store: LegionStore,
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

async function loadLastQa(store: LegionStore, lastQaId: string | null | undefined): Promise<{
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

function wikiEntry(page: WikiPageRow): SessionBrief["wiki"][number] {
  if (page.trust === "untrusted") {
    return { path: page.path, title: page.title, summary: null, trust: "untrusted" };
  }
  const summary = twoLineSummary(page.body);
  return {
    path: page.path,
    title: page.title,
    summary: summary.length > 0 ? summary : null,
    trust: "reviewed",
  };
}

function rankWikiPages(
  pages: WikiPageRow[],
  hubIds: Set<string>,
  specLinked: Set<string>,
): WikiPageRow[] {
  const score = (page: WikiPageRow): number => {
    if (hubIds.has(page.id)) return 0;
    if (specLinked.has(page.id) || [...specLinked].some((id) => page.id.endsWith(id) || id.endsWith(page.id))) {
      return 1;
    }
    if (page.trust === "untrusted") return 2;
    return 3;
  };
  return [...pages].sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
}

export function renderSessionBrief(brief: SessionBrief): string {
  const lines: string[] = [];
  lines.push(`Project: ${brief.project.name} (${brief.project.mode}, ${brief.project.controlMode})`);
  lines.push(`Phase: ${brief.phase}`);
  if (brief.currentTask) {
    lines.push(`Current task: ${brief.currentTask.id} ${brief.currentTask.title}`);
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
  lines.push("");
  lines.push("Wiki:");
  if (brief.wiki.length === 0) {
    lines.push("- (none)");
  } else {
    for (const page of brief.wiki) {
      if (page.trust === "untrusted") {
        lines.push(`- ${page.title} (${page.path}) untrusted`);
      } else if (page.summary) {
        lines.push(`- ${page.title} (${page.path})`);
        for (const summaryLine of page.summary.split("\n")) {
          lines.push(`  ${summaryLine}`);
        }
      } else {
        lines.push(`- ${page.title} (${page.path})`);
      }
    }
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
}): SessionBrief {
  const base = {
    schemaVersion: SCHEMA_VERSION.brief,
    project: input.project,
    phase: input.phase,
    currentTask: input.currentTask ?? null,
    blockers: input.blockers.slice(0, 5),
    decisions: input.decisions.slice(0, 10),
    wiki: input.wiki,
    contract: input.contract ?? null,
    lastQa: input.lastQa ?? null,
  };
  let rendered = renderSessionBrief(withCount(base, ""));
  let wiki = input.wiki;
  if (rendered.length > SESSION_BRIEF_CHAR_CAP) {
    wiki = wiki.map((page) => ({ ...page, summary: null }));
    rendered = renderSessionBrief(withCount({ ...base, wiki }, ""));
  }
  while (rendered.length > SESSION_BRIEF_CHAR_CAP && wiki.length > 0) {
    wiki = wiki.slice(0, -1);
    rendered = renderSessionBrief(withCount({ ...base, wiki }, ""));
  }
  if (rendered.length > SESSION_BRIEF_CHAR_CAP) {
    rendered = rendered.slice(0, SESSION_BRIEF_CHAR_CAP);
  }
  return withCount({ ...base, wiki }, rendered);
}

export async function ensureWikiIndex(store: LegionStore): Promise<void> {
  try {
    queryIndex(store.projectRoot, "SELECT 1 FROM pages LIMIT 1");
  } catch {
    await store.rebuild();
  }
}

export async function buildSessionBrief(store: LegionStore): Promise<SessionBrief> {
  await ensureWikiIndex(store);
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
      currentTask = { id: task.id, title: task.title };
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

  const pages = loadWikiPages(store.projectRoot);
  const links = loadWikiLinks(store.projectRoot);
  const hubIds = new Set(hubs(links).map((row) => row.id));
  const ranked = rankWikiPages(pages, hubIds, specLinked);
  const wiki = ranked.map(wikiEntry);
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
  });
}
