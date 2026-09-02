import type { ShownPage } from "@9thlevelsoftware/legion-cli-wiki";
import { KANBAN_COLUMNS, type DashboardSnapshot, type DashboardTask } from "./snapshot.js";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const CSS = `
:root { --bg:#f5f5f0; --ink:#222; --accent:#c45c26; --muted:#888; --card:#fff; }
html, body { background:var(--bg); color:var(--ink); font-family:Georgia,"Times New Roman",serif; margin:0; }
a { color:var(--accent); }
.muted { color:var(--muted); }
header { padding:1rem 1.5rem; border-bottom:1px solid var(--muted); }
header nav a { margin-right:1rem; }
main { padding:1.5rem; }
.banner { background:var(--accent); color:var(--bg); padding:0.75rem 1.5rem; }
.readonly { font-size:0.9rem; }
.path { display:flex; flex-wrap:wrap; gap:0.35rem; list-style:none; padding:0; }
.path li { padding:0.15rem 0.5rem; border:1px solid var(--muted); }
.path li.current { border-color:var(--accent); color:var(--accent); }
.board { display:grid; grid-template-columns:repeat(auto-fit,minmax(11rem,1fr)); gap:0.75rem; }
.col { background:var(--card); border:1px solid var(--muted); min-height:8rem; padding:0.75rem; }
.col h2 { font-size:1rem; margin:0 0 0.5rem; }
.card { border:1px solid var(--ink); padding:0.5rem; margin:0 0 0.5rem; }
.card.current { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
.card h3 { margin:0 0 0.25rem; font-size:1rem; }
pre { white-space:pre-wrap; overflow:auto; }
iframe.wireframes { width:100%; min-height:24rem; border:1px solid var(--ink); background:var(--card); }
.edges { list-style:none; padding:0; }
`.trim();

export type DashboardHtmlOpts = {
  token: string;
  alert?: string;
  webmcp?: boolean;
};

function layout(title: string, body: string, opts: DashboardHtmlOpts): string {
  const banner = opts.alert ? `<div class="banner">${escapeHtml(opts.alert)}</div>` : "";
  const script = opts.webmcp ? `  <script src="/webmcp.js" defer></script>\n` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="legion-cli-token" content="${escapeHtml(opts.token)}">
  <title>${escapeHtml(title)}</title>
  <style>
${CSS}
  </style>
</head>
<body>
  <header>
    <p class="muted">Legion CLI viewer</p>
    <nav>
      <a href="/">Board</a>
      <a href="/spec">Spec</a>
      <a href="/graph">Graph</a>
      <a href="/audit">Audit</a>
      <a href="/wiki">Wiki</a>
    </nav>
    <p class="readonly muted">Viewer with optional writes. CLI remains the source of truth.</p>
  </header>
  ${banner}
  <main>
${body}
  </main>
${script}</body>
</html>
`;
}

function pathList(snapshot: DashboardSnapshot): string {
  const items = snapshot.path.steps
    .map((step) => {
      const cls = step === snapshot.path.current ? "current" : "";
      return `      <li class="${cls}">${escapeHtml(step)}</li>`;
    })
    .join("\n");
  const extra =
    snapshot.path.steps.includes(snapshot.path.current) ?
      ""
    : `      <li class="current">${escapeHtml(snapshot.path.current)}</li>`;
  return `    <ol class="path">\n${items}${extra ? `\n${extra}` : ""}\n    </ol>`;
}

function taskCard(task: DashboardTask, currentId: string | null): string {
  const current = task.id === currentId ? " current" : "";
  const deps =
    task.blockedBy.length > 0 ?
      `<p class="muted">blocked by ${escapeHtml(task.blockedBy.join(", "))}</p>`
    : "";
  const unresolved =
    task.unresolved.length > 0 ?
      `<p class="muted">waiting on ${escapeHtml(task.unresolved.join(", "))}</p>`
    : "";
  const adapterAttr = task.adapter ? ` data-adapter="${escapeHtml(task.adapter)}"` : "";
  const meta =
    task.adapter ?
      `${escapeHtml(task.priority)} · ${escapeHtml(task.status)} · ${escapeHtml(task.adapter)}`
    : `${escapeHtml(task.priority)} · ${escapeHtml(task.status)}`;
  return `<article class="card${current}" data-task="${escapeHtml(task.id)}" data-status="${escapeHtml(task.status)}"${adapterAttr}>
        <h3>${escapeHtml(task.id)}</h3>
        <p>${escapeHtml(task.title)}</p>
        <p class="muted">${meta}</p>
        ${deps}${unresolved}
      </article>`;
}

function alertFor(snapshot: DashboardSnapshot): string | undefined {
  if (snapshot.blockers.some((item) => item.kind === "task")) return "Blocked work on the board";
  if (snapshot.lastReadiness === "FAIL") return "Readiness FAIL";
  if (snapshot.lastReview === "FAIL") return "Review FAIL";
  return undefined;
}

export function renderKanban(snapshot: DashboardSnapshot, token = "", webmcp = false): string {
  const name = snapshot.project?.name ?? "(uninitialized)";
  const current = snapshot.currentTask
    ? `${snapshot.currentTask.id} ${snapshot.currentTask.title}`
    : "none";
  const cols = KANBAN_COLUMNS.map((status) => {
    const cards = snapshot.tasks.filter((task) => task.status === status);
    const extra =
      status === "done" ? snapshot.tasks.filter((task) => task.status === "compacted") : [];
    const body = [...cards, ...extra]
      .map((task) => taskCard(task, snapshot.currentTaskId))
      .join("\n        ");
    return `    <section class="col" data-column="${status}">
      <h2>${escapeHtml(status)}</h2>
      ${body}
    </section>`;
  }).join("\n");
  const blockers =
    snapshot.blockers.length === 0 ?
      `<p class="muted">No blockers.</p>`
    : `<ul>${snapshot.blockers.map((item) => `<li>${escapeHtml(item.detail)}</li>`).join("")}</ul>`;
  const timeline =
    snapshot.audit.length === 0 ?
      `<p class="muted">No audit events yet. Timeline follows the path above.</p>`
    : `<ol>${snapshot.audit
        .slice(-20)
        .reverse()
        .map(
          (event) =>
            `<li><span class="muted">${escapeHtml(event.ts)}</span> ${escapeHtml(event.type)} · ${escapeHtml(event.phase)}${event.taskId ? ` · ${escapeHtml(event.taskId)}` : ""}</li>`,
        )
        .join("")}</ol>`;
  const body = `
    <h1>${escapeHtml(name)}</h1>
    <p>phase: <strong>${escapeHtml(snapshot.phase)}</strong> · current task: <strong>${escapeHtml(current)}</strong></p>
    <h2>Path</h2>
${pathList(snapshot)}
    <h2>Kanban</h2>
    <div class="board">
${cols}
    </div>
    <h2>Blockers</h2>
    ${blockers}
    <h2>Timeline</h2>
    ${timeline}
`;
  return layout(`${name} · board`, body, { token, alert: alertFor(snapshot), webmcp });
}

export function renderSpec(snapshot: DashboardSnapshot, token = "", webmcp = false): string {
  if (!snapshot.spec) {
    return layout("Spec", `<h1>Spec</h1><p class="muted">No active spec yet.</p>`, { token, webmcp });
  }
  const iframe =
    snapshot.wireframesIndex ?
      `<h2>Wireframes</h2>
    <iframe class="wireframes" title="wireframes" src="/spec/wireframes/INDEX.html"></iframe>`
    : `<p class="muted">No wireframes index.</p>`;
  const prd =
    snapshot.prd ?
      `<h2>PRD</h2>\n    <pre>${escapeHtml(snapshot.prd)}</pre>`
    : `<p class="muted">No PRD yet.</p>`;
  const body = `
    <h1>${escapeHtml(snapshot.spec.title)}</h1>
    <p class="muted">${escapeHtml(snapshot.spec.id)} · ${escapeHtml(snapshot.spec.status)}</p>
    <h2>SPEC</h2>
    <pre>${escapeHtml(snapshot.spec.body)}</pre>
    ${prd}
    ${iframe}
`;
  return layout(`Spec · ${snapshot.spec.title}`, body, { token, webmcp });
}

export function renderGraph(snapshot: DashboardSnapshot, token: string = "", webmcp = false): string {
  const nodes =
    snapshot.graph.nodes.length === 0 ?
      `<p class="muted">No tasks yet. Kanban still works once tasks exist (including todo).</p>`
    : `<ul>${snapshot.tasks
        .map((task) => {
          const deps =
            task.blockedBy.length > 0 ? ` ← ${escapeHtml(task.blockedBy.join(", "))}` : "";
          return `<li data-node="${escapeHtml(task.id)}">${escapeHtml(task.id)} ${escapeHtml(task.title)} (${escapeHtml(task.status)})${deps}</li>`;
        })
        .join("")}</ul>`;
  const edges =
    snapshot.graph.edges.length === 0 ?
      `<p class="muted">No dependency edges.</p>`
    : `<ul class="edges">${snapshot.graph.edges
        .map(
          (edge) =>
            `<li data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}">${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</li>`,
        )
        .join("")}</ul>`;
  const body = `
    <h1>Task graph</h1>
    <h2>Nodes</h2>
    ${nodes}
    <h2>Dependencies</h2>
    ${edges}
`;
  return layout("Task graph", body, { token, webmcp });
}

export function renderAudit(snapshot: DashboardSnapshot, token = "", webmcp = false): string {
  const rows =
    snapshot.audit.length === 0 ?
      `<p class="muted">No audit events yet. Ship will write events.jsonl; ingest receipts appear here when present.</p>`
    : `<ol>${snapshot.audit
        .slice()
        .reverse()
        .map((event) => {
          const task = event.taskId ? ` · ${escapeHtml(event.taskId)}` : "";
          return `<li><span class="muted">${escapeHtml(event.ts)}</span> ${escapeHtml(event.type)} · ${escapeHtml(event.phase)}${task} · ${escapeHtml(event.actor)}</li>`;
        })
        .join("")}</ol>`;
  return layout("Audit", `<h1>Audit trail</h1>\n    ${rows}`, { token, webmcp });
}

export function renderWikiIndex(
  pages: Array<{ id: string; title: string; path: string; trust: string }>,
  token: string,
  webmcp = false,
): string {
  const list =
    pages.length === 0 ?
      `<p class="muted">No wiki pages.</p>`
    : `<ul>${pages
        .map(
          (page) =>
            `<li><a href="/wiki/${encodeURI(page.id)}">${escapeHtml(page.title)}</a> <span class="muted">${escapeHtml(page.id)} · ${escapeHtml(page.trust)}</span></li>`,
        )
        .join("")}</ul>`;
  return layout("Wiki", `<h1>Wiki</h1>\n    ${list}`, { token, webmcp });
}

export function renderWikiPage(page: ShownPage, backlinks: string[], token: string, webmcp = false): string {
  const trust = page.trust ? `<p class="muted">trust: ${escapeHtml(page.trust)}</p>` : "";
  const links =
    backlinks.length === 0 ?
      `<p class="muted">No backlinks.</p>`
    : `<ul>${backlinks
        .map((id) => `<li><a href="/wiki/${encodeURI(id)}">${escapeHtml(id)}</a></li>`)
        .join("")}</ul>`;
  const body = `
    <h1>${escapeHtml(page.title)}</h1>
    <p class="muted">${escapeHtml(page.kind)} · ${escapeHtml(page.path)}</p>
    ${trust}
    <pre>${escapeHtml(page.body)}</pre>
    <h2>Backlinks</h2>
    ${links}
`;
  return layout(page.title, body, { token, webmcp });
}

export function renderNotFound(message: string, token: string, webmcp = false): string {
  return layout("Not found", `<h1>Not found</h1><p>${escapeHtml(message)}</p>`, { token, webmcp });
}
