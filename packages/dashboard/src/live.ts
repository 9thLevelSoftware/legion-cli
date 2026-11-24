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
    const wfEl = $("#dashboard-workflow");
    if (wfEl) {
      if (snapshot.workflowError) {
        const p = document.createElement("p"); p.textContent = "Workflow status unavailable: " + text(snapshot.workflowError); wfEl.replaceChildren(p);
      } else if (!snapshot.workflow) {
        const p = document.createElement("p"); p.className = "muted"; p.textContent = "Focused workflow projection not active."; wfEl.replaceChildren(p);
      } else {
        const wf = snapshot.workflow;
        const p1 = document.createElement("p");
        p1.textContent = "Stage: " + text(wf.stage) + " · Plan approval: " + text(wf.planApproval) + " · Execution: " + text(wf.execution);
        const p2 = document.createElement("p");
        const checkDetail = wf.checks.total === 0 ? "none" : wf.checks.passed + "/" + wf.checks.total + " passed" + (wf.checks.failed > 0 ? ", " + wf.checks.failed + " failed" : "");
        const reviewDetail = wf.review.verdict ? wf.review.status + " (" + wf.review.verdict + ")" : wf.review.status;
        p2.textContent = "Checks: " + text(wf.checks.status) + " (" + checkDetail + ") · Review: " + reviewDetail;
        const p3 = document.createElement("p");
        const acc = wf.acceptance;
        p3.textContent = "Acceptance: " + (acc.required.length === 0 ? "none required" : acc.passed.length + "/" + acc.required.length + " passed · " + acc.pending.length + " pending · " + acc.failed.length + " failed · " + acc.notApplicable.length + " N/A");
        const nodes = [p1, p2, p3];
        if (wf.blocker) { const b = document.createElement("p"); b.textContent = "Blocker: " + text(wf.blocker); nodes.push(b); }
        wfEl.replaceChildren(...nodes);
      }
    }
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
