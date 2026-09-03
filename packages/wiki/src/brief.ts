import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  extractWikiLinks,
  queryIndex,
  type LegionReader,
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
    const adapterBit = brief.currentTask.adapter ? ` (${brief.currentTask.adapter})` : "";
    lines.push(`Current task: ${brief.currentTask.id} ${brief.currentTask.title}${adapterBit}`);
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
  skills?: SessionBrief["skills"];
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
  };
  let wiki = input.wiki;
  let skills = input.skills;

  const snapshot = (): Omit<SessionBrief, "characterCount"> => ({
    ...base,
    wiki,
    ...(skills !== undefined ? { skills } : {}),
  });
  const render = (): string => renderSessionBrief(withCount(snapshot(), ""));

  let rendered = render();
  if (rendered.length > SESSION_BRIEF_CHAR_CAP) {
    wiki = wiki.map((page) => ({ ...page, summary: null }));
    rendered = render();
  }
  while (rendered.length > SESSION_BRIEF_CHAR_CAP && wiki.length > 0) {
    wiki = wiki.slice(0, -1);
    rendered = render();
  }
  if (rendered.length > SESSION_BRIEF_CHAR_CAP && skills && skills.length > 0) {
    skills = skills.map((skill) => ({ ...skill, description: "" }));
    rendered = render();
  }
  if (rendered.length > SESSION_BRIEF_CHAR_CAP && skills && skills.length > 0) {
    skills = skills.filter((skill) => skill.active === true);
    rendered = render();
  }
  return withCount(snapshot(), rendered);
}

export function wikiIndexReady(projectRoot: string): boolean {
  try {
    queryIndex(projectRoot, "SELECT 1 FROM pages LIMIT 1");
    return true;
  } catch {
    return false;
  }
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

export async function buildSessionBrief(
  store: LegionReader,
  opts?: { rebuild?: boolean; skills?: SessionBrief["skills"] },
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
    skills: opts?.skills,
  });
}
