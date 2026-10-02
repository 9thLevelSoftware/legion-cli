/** Browser-side, dependency-free updates for the read-only dashboard. */
export const DASHBOARD_SCRIPT = `
(() => {
  const $ = (selector) => document.querySelector(selector);
  const live = $("#dashboard-live");
  const freshness = $("#dashboard-freshness");
  const text = (value) => String(value ?? "");
  const announce = (message) => { if (live) live.textContent = message; };
  const copyCommands = () => document.querySelectorAll("[data-copy-command]").forEach((button) => {
    button.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(button.dataset.copyCommand || ""); announce("Command copied."); }
      catch { announce("Copy failed; select the command text instead."); }
    });
  });
  const card = (task, currentId) => {
    const el = document.createElement("article");
    el.className = "card" + (task.id === currentId ? " current" : "");
    el.tabIndex = 0; el.dataset.task = task.id; el.dataset.status = task.status; el.setAttribute("aria-selected", "false");
    el.innerHTML = "<h3></h3><p></p><p class=muted></p>";
    el.querySelector("h3").textContent = task.id;
    el.querySelectorAll("p")[0].textContent = task.title;
    el.querySelectorAll("p")[1].textContent = task.priority + " · " + task.status + (task.adapter ? " · " + task.adapter : "");
    if (task.blockedBy.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "blocked by " + task.blockedBy.join(", "); el.append(p); }
    if (task.unresolved.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "waiting on " + task.unresolved.join(", "); el.append(p); }
    return el;
  };
  const update = (snapshot) => {
    const summary = $("#dashboard-summary");
    if (summary) summary.textContent = "phase: " + (snapshot.stateError || snapshot.phase) + " · current task: " + (snapshot.currentTask ? snapshot.currentTask.id + " " + snapshot.currentTask.title : "none");
    const board = $("#dashboard-board");
    if (board) document.querySelectorAll("[data-column]").forEach((col) => {
      col.querySelectorAll(".card").forEach((node) => node.remove());
      const status = col.dataset.column;
      snapshot.tasks.filter((task) => task.status === status || (status === "done" && task.status === "compacted")).forEach((task) => col.append(card(task, snapshot.currentTaskId)));
    });
    const blockers = $("#dashboard-blockers");
    if (blockers) blockers.replaceChildren(...(snapshot.blockers.length ? snapshot.blockers.map((item) => { const li = document.createElement("li"); li.textContent = item.detail; return li; }) : [Object.assign(document.createElement("p"), { className: "muted", textContent: "No blockers." })]));
    const path = $("#dashboard-path");
    if (path) path.querySelectorAll("li").forEach((li) => li.classList.toggle("current", li.textContent === snapshot.path.current));
    const evidence = $("#dashboard-evidence");
    if (evidence) evidence.textContent = "Evidence: " + text(snapshot.evidenceCoverage);
    const next = $("#dashboard-next");
    if (next) next.textContent = text(snapshot.nextCommand);
    document.querySelectorAll("[data-copy-command]").forEach((button) => { button.dataset.copyCommand = text(snapshot.nextCommand || "legion-cli status"); });
    if (freshness) freshness.textContent = "Live update: " + new Date().toLocaleTimeString();
    announce("Dashboard updated. Phase " + (snapshot.stateError || snapshot.phase) + ".");
  };
  const refresh = async () => { const response = await fetch("/api/state", { cache: "no-store" }); if (!response.ok) throw new Error("state request failed"); update(await response.json()); };
  document.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && event.target.matches(".card")) { event.preventDefault(); document.querySelectorAll(".card.selected").forEach((node) => { node.classList.remove("selected"); node.setAttribute("aria-selected", "false"); }); event.target.classList.add("selected"); event.target.setAttribute("aria-selected", "true"); announce("Selected task " + event.target.dataset.task + "."); } });
  document.addEventListener("click", (event) => { if (event.target.closest("[data-manual-refresh]")) refresh().catch(() => announce("Refresh failed. Try again.")); });
  copyCommands();
  if (!("EventSource" in window)) { announce("Live updates unavailable; use Refresh."); return; }
  const events = new EventSource("/events");
  events.addEventListener("state", (event) => { try { update(JSON.parse(event.data)); } catch { announce("Live update could not be read; use Refresh."); } });
  events.addEventListener("audit-delta", () => refresh().catch(() => announce("Audit refresh failed; use Refresh.")));
  events.addEventListener("error", () => { if (freshness) freshness.textContent = "Live connection reconnecting; use Refresh if needed."; });
})();
`.trim();
