import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ServeFileSchema } from "@9thlevelsoftware/legion-cli-schema";
import {
  ENGINE_WRITE_METHODS,
  startDashboard,
  WEBMCP_SCRIPT,
  WEBMCP_SCRIPT_PATH,
  WEBMCP_TOOLS,
} from "../dist/index.js";
import { otherSpecTask, todoTask, withStore, withTempDir } from "./helpers.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function withServer(dir, fn, extra = {}) {
  const opened = [];
  const warns = [];
  const handle = await startDashboard({
    projectRoot: dir,
    host: extra.host ?? "127.0.0.1",
    port: 0,
    open: extra.open ?? false,
    openBrowser: (url) => opened.push(url),
    warn: (message) => warns.push(message),
    pollMs: extra.pollMs ?? 200,
    webmcp: extra.webmcp,
  });
  try {
    return await fn({ handle, opened, warns });
  } finally {
    await handle.close();
  }
}

function originFor(handle) {
  return `http://127.0.0.1:${handle.port}`;
}

function tokenFromWarns(warns) {
  const match = /Write token: ([0-9a-f]{64})/.exec(warns.join("\n"));
  assert.ok(match, "expected write token on stderr");
  return match[1];
}

function assertHtmlOmitsToken(html, token) {
  assert.doesNotMatch(html, /legion-cli-token/);
  assert.doesNotMatch(html, /<meta name="legion-cli-token"/);
  assert.equal(html.includes(token), false);
}

function assertWebmcpHeaders(headers) {
  const csp = headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.equal(headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(headers.get("origin-agent-cluster"), "?1");
}

function assertWebmcpOffHeaders(headers) {
  const csp = headers.get("content-security-policy") ?? "";
  assert.doesNotMatch(csp, /script-src 'self'/);
  assert.equal(headers.get("cross-origin-opener-policy"), null);
  assert.equal(headers.get("cross-origin-embedder-policy"), null);
}

async function enableConfigWebmcp(dir) {
  const path = join(dir, ".legion-cli", "config.yaml");
  const current = await readFile(path, "utf8");
  await writeFile(path, `${current.trimEnd()}\nflags:\n  webmcp: true\n`, "utf8");
}

function assertSandboxedIframe(html) {
  const iframe = /<iframe\b[^>]*>/.exec(html);
  assert.ok(iframe, "expected wireframe iframe");
  const tag = iframe[0];
  assert.match(tag, /\bsandbox\b/);
  const quoted = /\bsandbox="([^"]*)"/.exec(tag);
  const tokens = quoted ? quoted[1].trim().split(/\s+/).filter(Boolean) : [];
  assert.equal(
    tokens.includes("allow-same-origin") && tokens.includes("allow-scripts"),
    false,
    "sandbox must not combine allow-same-origin and allow-scripts",
  );
}

async function enginePost(handle, path, body, extra = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(extra.origin !== null ? { Origin: extra.origin ?? originFor(handle) } : {}),
    ...(extra.token ? { "X-Legion-Cli-Token": extra.token } : {}),
    ...extra.headers,
  };
  return fetch(`${handle.url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("package writes via LegionEngine and does not expose execute", async () => {
  const pkg = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "@9thlevelsoftware/legion-cli-dashboard");
  assert.ok(pkg.dependencies["@9thlevelsoftware/legion-cli-core"]);
  assert.ok(pkg.dependencies["@9thlevelsoftware/legion-cli-persist"]);
  assert.ok(pkg.dependencies["@9thlevelsoftware/legion-cli-graph"]);
  assert.ok(pkg.dependencies["@9thlevelsoftware/legion-cli-wiki"]);
  const write = await readFile(join(pkgRoot, "src", "write.ts"), "utf8");
  const server = await readFile(join(pkgRoot, "src", "server.ts"), "utf8");
  assert.match(write, /createLegionEngine/);
  assert.match(write, /fileTicket/);
  assert.match(write, /wikiTrust/);
  assert.match(write, /qaChecklist/);
  assert.doesNotMatch(write, /\.execute\(/);
  assert.doesNotMatch(write, /\badapter\b/);
  assert.doesNotMatch(server, /\.execute\(/);
  assert.doesNotMatch(server, /Set-Cookie|set-cookie|cookie=/);
});

test("ENGINE_WRITE_METHODS is exactly ticket, wikiTrust, qaChecklist", () => {
  assert.deepEqual(ENGINE_WRITE_METHODS, new Set(["ticket", "wikiTrust", "qaChecklist"]));
  assert.equal(ENGINE_WRITE_METHODS.has("execute"), false);
  assert.equal(ENGINE_WRITE_METHODS.has("packet"), false);
  assert.equal(ENGINE_WRITE_METHODS.has("ship"), false);
  assert.equal(ENGINE_WRITE_METHODS.has("plan"), false);
  assert.equal(ENGINE_WRITE_METHODS.has("review"), false);
  assert.equal(ENGINE_WRITE_METHODS.has("intent"), false);
});

test("binds 127.0.0.1, GET kanban/spec/graph/audit/api/state, origin allowlist, no token in HTML", async () => {
  await withStore(async ({ dir, store }) => {
    await store.writeTask(todoTask(), "Show on the board before execute.\n");
    await withServer(dir, async ({ handle, opened, warns }) => {
      assert.equal(handle.host, "127.0.0.1");
      assert.equal(opened.length, 0);
      assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(handle.token, /^[0-9a-f]{64}$/);
      assert.equal(tokenFromWarns(warns), handle.token);

      const board = await fetch(handle.url);
      assert.equal(board.status, 200);
      const html = await board.text();
      assert.match(html, /Kanban/);
      assert.match(html, /TSK-0002/);
      assert.match(html, /TSK-0003/);
      assert.match(html, /board column/);
      assert.match(html, /data-status="todo"/);
      assert.match(html, /data-column="todo"/);
      assert.match(html, /phase:/);
      assert.match(html, /current task:/);
      assert.match(html, /source of truth/);
      assert.match(html, /Read-only viewer/);
      assert.match(html, /ticket\|wikiTrust\|qaChecklist/);
      assertHtmlOmitsToken(html, handle.token);
      assert.doesNotMatch(html, /webmcp\.js/);
      assert.equal(handle.webmcp, false);
      assert.equal(board.headers.get("access-control-allow-origin"), null);
      assert.equal(board.headers.get("set-cookie"), null);
      assert.equal(board.headers.get("content-security-policy")?.includes("connect-src 'self'"), true);

      const missing = await fetch(`${handle.url}/nope`);
      assert.equal(missing.status, 404);
      assertHtmlOmitsToken(await missing.text(), handle.token);

      const allowedOrigin = originFor(handle);
      const allowed = await fetch(handle.url, { headers: { Origin: allowedOrigin } });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get("access-control-allow-origin"), allowedOrigin);
      assert.notEqual(allowed.headers.get("access-control-allow-origin"), "*");

      const denied = await fetch(handle.url, { headers: { Origin: "http://evil.example" } });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("access-control-allow-origin"), null);

      const rootPost = await fetch(handle.url, { method: "POST", body: "{}" });
      assert.equal(rootPost.status, 405);
      assert.match(rootPost.headers.get("allow") ?? "", /GET/);

      const enginePostState = await fetch(`${handle.url}/api/state`, { method: "POST", body: "{}" });
      assert.equal(enginePostState.status, 405);

      const stateRes = await fetch(`${handle.url}/api/state`);
      assert.equal(stateRes.status, 200);
      const state = await stateRes.json();
      assert.equal(state.readOnly, true);
      assert.equal(state.phase, "executing");
      assert.equal(state.currentTaskId, "TSK-0002");
      assert.ok(state.tasks.some((task) => task.id === "TSK-0003" && task.status === "todo"));
      assert.equal(
        state.tasks.find((task) => task.id === "TSK-0003")?.adapter,
        undefined,
      );
      assert.equal(
        state.tasks.find((task) => task.id === "TSK-0002")?.adapter,
        undefined,
      );
      assert.ok(state.graph.edges.some((edge) => edge.from === "TSK-0001" && edge.to === "TSK-0002"));

      const spec = await fetch(`${handle.url}/spec`);
      assert.equal(spec.status, 200);
      assert.match(await spec.text(), /Office check-in/);

      const graph = await fetch(`${handle.url}/graph`);
      assert.equal(graph.status, 200);
      const graphHtml = await graph.text();
      assert.match(graphHtml, /TSK-0002/);
      assert.match(graphHtml, /TSK-0001 → TSK-0002/);

      const audit = await fetch(`${handle.url}/audit`);
      assert.equal(audit.status, 200);
      assert.match(await audit.text(), /Audit trail/);

      const wiki = await fetch(`${handle.url}/wiki/product/intent`);
      assert.equal(wiki.status, 200);
      const wikiHtml = await wiki.text();
      assert.match(wikiHtml, /Intent/);
      assert.match(wikiHtml, /Backlinks/);
    });
  });
});

test("POST /engine/* requires token and origin; ticket/wikiTrust/qaChecklist mutate via engine", async () => {
  await withStore(async ({ dir, store }) => {
    await store.writeTask(todoTask(), "Show on the board before execute.\n");
    await store.writeWikiPage(
      ".legion-cli/wiki/ingested/notes.md",
      {
        schemaVersion: "legion-cli-wiki-page/v1",
        title: "Notes",
        aliases: [],
        tags: ["wiki"],
        trust: "untrusted",
        updated: "2026-09-01T12:00:00.000Z",
      },
      "A durable fact from notes.\n",
    );
    await store.rebuild();
    await withServer(dir, async ({ handle, warns }) => {
      const html = await (await fetch(handle.url)).text();
      const token = handle.token;
      assert.equal(tokenFromWarns(warns), token);
      assertHtmlOmitsToken(html, token);
      const origin = originFor(handle);

      const noToken = await enginePost(handle, "/engine/ticket", { title: "park extra" });
      assert.equal(noToken.status, 403);
      assert.equal(noToken.headers.get("access-control-allow-origin"), origin);
      assert.notEqual(noToken.headers.get("access-control-allow-origin"), "*");
      assert.equal(noToken.headers.get("set-cookie"), null);

      const badToken = await enginePost(handle, "/engine/ticket", { title: "park extra" }, { token: "nope" });
      assert.equal(badToken.status, 403);

      const cookieOnly = await enginePost(
        handle,
        "/engine/ticket",
        { title: "park extra" },
        { headers: { Cookie: `legion-cli-token=${token}` } },
      );
      assert.equal(cookieOnly.status, 403);

      const noOrigin = await enginePost(
        handle,
        "/engine/ticket",
        { title: "park extra" },
        { token, origin: null },
      );
      assert.equal(noOrigin.status, 403);

      const evil = await enginePost(
        handle,
        "/engine/ticket",
        { title: "park extra" },
        { token, origin: "http://evil.example" },
      );
      assert.equal(evil.status, 403);
      assert.equal(evil.headers.get("access-control-allow-origin"), null);

      const execute = await enginePost(handle, "/engine/execute", { id: "TSK-0002" }, { token });
      assert.equal(execute.status, 404);

      const packet = await enginePost(handle, "/engine/packet", { title: "Dark mode" }, { token });
      assert.equal(packet.status, 404);

      const ship = await enginePost(handle, "/engine/ship", {}, { token });
      assert.equal(ship.status, 404);

      const plan = await enginePost(handle, "/engine/plan", {}, { token });
      assert.equal(plan.status, 404);

      const review = await enginePost(handle, "/engine/review", {}, { token });
      assert.equal(review.status, 404);

      const qa = await enginePost(handle, "/engine/qa", { mode: "full" }, { token });
      assert.equal(qa.status, 404);

      const ticketRes = await enginePost(
        handle,
        "/engine/ticket",
        { title: "park extra from board", adapter: "grok" },
        { token },
      );
      assert.equal(ticketRes.status, 200, await ticketRes.clone().text());
      assert.equal(ticketRes.headers.get("access-control-allow-origin"), origin);
      assert.notEqual(ticketRes.headers.get("access-control-allow-origin"), "*");
      const ticketBody = await ticketRes.json();
      assert.equal(ticketBody.ok, true);
      assert.match(ticketBody.id, /^TSK-\d+$/);
      const filed = await store.readTask(ticketBody.id);
      assert.equal(filed.data.title, "park extra from board");
      assert.equal(filed.data.specId, "spec-checkin");
      assert.equal(filed.data.adapter, undefined);

      const trustRes = await enginePost(
        handle,
        "/engine/wikiTrust",
        { pageId: "ingested/notes" },
        { token },
      );
      assert.equal(trustRes.status, 200, await trustRes.clone().text());
      const trusted = await store.readWikiPage(".legion-cli/wiki/ingested/notes.md");
      assert.equal(trusted.data.trust, "reviewed");

      const checklistRes = await enginePost(
        handle,
        "/engine/qaChecklist",
        { ticks: ["AC-01"] },
        { token },
      );
      assert.equal(checklistRes.status, 200, await checklistRes.clone().text());
      const checklist = JSON.parse(
        await readFile(join(dir, ".legion-cli", "qa", "checklist.json"), "utf8"),
      );
      assert.equal(checklist.specId, "spec-checkin");
      assert.deepEqual(checklist.ticks, ["AC-01"]);
    });
  });
});

test("POST /engine/ticket persists type/priority and refuses invalid enums without writing", async () => {
  await withStore(async ({ dir, store }) => {
    await withServer(dir, async ({ handle }) => {
      const token = handle.token;
      const badType = await enginePost(handle, "/engine/ticket", { title: "park extra", type: "nope" }, { token });
      assert.equal(badType.status, 400);
      assert.match(await badType.text(), /type must be feature \| fix \| bug/);
      await assert.rejects(() => store.readTask("TSK-0003"));

      const badPriority = await enginePost(
        handle,
        "/engine/ticket",
        { title: "park extra", priority: "P9" },
        { token },
      );
      assert.equal(badPriority.status, 400);
      assert.match(await badPriority.text(), /priority must be P0 \| P1 \| P2/);
      await assert.rejects(() => store.readTask("TSK-0003"));

      const ok = await enginePost(
        handle,
        "/engine/ticket",
        { title: "park extra from board", type: "bug", priority: "P0" },
        { token },
      );
      assert.equal(ok.status, 200, await ok.clone().text());
      const body = await ok.json();
      const filed = await store.readTask(body.id);
      assert.equal(filed.data.type, "bug");
      assert.equal(filed.data.priority, "P0");
    });
  });
});

test("POST /engine/* returns 409 while a live spawn is in_progress", async () => {
  await withStore(async ({ dir, store }) => {
    const live = (await store.readTask("TSK-0002")).data;
    await store.writeTask({ ...live, status: "in_progress" }, "Implement the in/out button.\n");
    const resumeDir = join(dir, ".legion-cli", "cache", "runs", "execute-live");
    await mkdir(resumeDir, { recursive: true });
    await writeFile(
      join(resumeDir, "resume.json"),
      `${JSON.stringify(
        {
          schemaVersion: "legion-cli-resume/v1",
          runId: "execute-live",
          taskId: "TSK-0002",
          skillId: "execute",
          preSpawnRef: "UNBORN",
          startedAt: new Date().toISOString(),
          pid: process.pid,
          adapterId: "fake",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await store.rebuild();
    await withServer(dir, async ({ handle, warns }) => {
      const html = await (await fetch(handle.url)).text();
      const token = handle.token;
      assert.equal(tokenFromWarns(warns), token);
      assertHtmlOmitsToken(html, token);
      const ticketRes = await enginePost(handle, "/engine/ticket", { title: "park extra" }, { token });
      assert.equal(ticketRes.status, 409, await ticketRes.clone().text());
      const body = await ticketRes.json();
      assert.match(body.error, /in_progress/);
      assert.equal(body.next, "legion-cli status");
      const trustRes = await enginePost(handle, "/engine/wikiTrust", { pageId: "notes" }, { token });
      assert.equal(trustRes.status, 409);
      const getState = await fetch(`${handle.url}/api/state`);
      assert.equal(getState.status, 200);
    });
  });
});

test("SSE streams state; audit events appear on GET /audit", async () => {
  await withStore(async ({ dir, store }) => {
    await mkdir(store.paths.auditDir, { recursive: true });
    await writeFile(
      join(store.paths.auditDir, "events.jsonl"),
      `${JSON.stringify({
        schemaVersion: "legion-cli-audit/v1",
        ts: "2026-09-01T12:00:00.000Z",
        type: "phase",
        phase: "executing",
        taskId: "TSK-0002",
        actor: "cli",
        data: { from: "plan_ready" },
      })}\n`,
      "utf8",
    );
    await withServer(dir, async ({ handle }) => {
      const audit = await fetch(`${handle.url}/audit`);
      const auditHtml = await audit.text();
      assert.match(auditHtml, /phase/);
      assert.match(auditHtml, /TSK-0002/);

      const res = await fetch(`${handle.url}/events`, {
        headers: { Origin: originFor(handle) },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let chunk = "";
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("SSE timed out after 5s")), 5000);
      });
      try {
        while (!chunk.includes("event: state")) {
          const { value, done } = await Promise.race([reader.read(), timeout]);
          if (done) break;
          chunk += decoder.decode(value, { stream: true });
        }
      } finally {
        clearTimeout(timer);
        await reader.cancel();
      }
      assert.match(chunk, /event: state/);
      assert.match(chunk, /"readOnly":true/);
    });
  });
});

test("--expose binds 0.0.0.0, warns, and omits token from GET HTML", async () => {
  await withTempDir(async (dir) => {
    await withServer(
      dir,
      async ({ handle, warns }) => {
        assert.equal(handle.host, "0.0.0.0");
        const warning = warns.join("\n");
        assert.match(warning, /0\.0\.0\.0/);
        assert.match(warning, /not in GET HTML/);
        assert.equal(tokenFromWarns(warns), handle.token);
        const res = await fetch(`http://127.0.0.1:${handle.port}/`);
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.match(html, /uninitialized/);
        assertHtmlOmitsToken(html, handle.token);
      },
      { host: "0.0.0.0" },
    );
  });
});

test("board shows raw Task.adapter when set and omits it when unset", async () => {
  await withStore(async ({ dir, store }) => {
    await store.writeTask(todoTask({ adapter: "grok" }), "Show on the board before execute.\n");
    await withServer(dir, async ({ handle }) => {
      const board = await fetch(handle.url);
      assert.equal(board.status, 200);
      const html = await board.text();
      assert.match(html, /data-task="TSK-0003"[^>]*data-adapter="grok"/);
      assert.match(html, /P1 · todo · grok/);
      assert.doesNotMatch(html, /data-task="TSK-0002"[^>]*data-adapter=/);
      assert.doesNotMatch(html, /<select|<option|completions/i);

      const stateRes = await fetch(`${handle.url}/api/state`);
      assert.equal(stateRes.status, 200);
      const state = await stateRes.json();
      const routed = state.tasks.find((task) => task.id === "TSK-0003");
      const unset = state.tasks.find((task) => task.id === "TSK-0002");
      assert.equal(routed?.adapter, "grok");
      assert.equal(unset?.adapter, undefined);
      assert.equal("adapter" in unset, false);
    });
  });
});

test("snapshot imports core sliceTasks and never falls back to all tasks", async () => {
  const src = await readFile(join(pkgRoot, "src", "snapshot.ts"), "utf8");
  assert.match(src, /import \{ sliceTasks \} from "@9thlevelsoftware\/legion-cli-core"/);
  assert.doesNotMatch(src, /function sliceTasks/);
  assert.doesNotMatch(src, /if \(!activeSpecId\) return \[\.\.\.tasks\]/);
  assert.doesNotMatch(src, /slice\.length > 0 \? slice : \[\.\.\.tasks\]/);
});

test("empty or missing activeSpecId is []; other-spec task never appears", async () => {
  await withStore(async ({ dir, store }) => {
    await store.writeTask(todoTask(), "Show on the board before execute.\n");
    await store.writeTask(otherSpecTask(), "Belongs to another spec.\n");

    await withServer(dir, async ({ handle }) => {
      const stateRes = await fetch(`${handle.url}/api/state`);
      assert.equal(stateRes.status, 200);
      const state = await stateRes.json();
      assert.equal(state.activeSpecId, "spec-checkin");
      assert.deepEqual(
        state.tasks.map((task) => task.id).sort(),
        ["TSK-0002", "TSK-0003"],
      );
      assert.equal(
        state.tasks.some((task) => task.id === "TSK-9999" || task.specId === "spec-other"),
        false,
      );
      const board = await (await fetch(handle.url)).text();
      assert.match(board, /TSK-0002/);
      assert.match(board, /TSK-0003/);
      assert.doesNotMatch(board, /TSK-9999/);
    });

    const seeded = await store.readState();
    await store.writeState({ ...seeded.data, activeSpecId: null }, seeded.body);
    await withServer(dir, async ({ handle }) => {
      const state = await (await fetch(`${handle.url}/api/state`)).json();
      assert.equal(state.activeSpecId, null);
      assert.deepEqual(state.tasks, []);
      assert.equal(state.currentTask, null);
      assert.deepEqual(state.graph.nodes, []);
      assert.deepEqual(state.graph.edges, []);
      const board = await (await fetch(handle.url)).text();
      assert.doesNotMatch(board, /TSK-0002/);
      assert.doesNotMatch(board, /TSK-0003/);
      assert.doesNotMatch(board, /TSK-9999/);
    });

    await store.writeState({ ...seeded.data, activeSpecId: "spec-empty" }, seeded.body);
    await withServer(dir, async ({ handle }) => {
      const state = await (await fetch(`${handle.url}/api/state`)).json();
      assert.equal(state.activeSpecId, "spec-empty");
      assert.deepEqual(state.tasks, []);
      assert.equal(state.currentTask, null);
      assert.deepEqual(state.graph.nodes, []);
      assert.deepEqual(state.graph.edges, []);
      const board = await (await fetch(handle.url)).text();
      assert.doesNotMatch(board, /TSK-0002/);
      assert.doesNotMatch(board, /TSK-9999/);
    });

    await store.writeState({ ...seeded.data, activeSpecId: "spec-other" }, seeded.body);
    await withServer(dir, async ({ handle }) => {
      const state = await (await fetch(`${handle.url}/api/state`)).json();
      assert.equal(state.activeSpecId, "spec-other");
      assert.deepEqual(
        state.tasks.map((task) => task.id),
        ["TSK-9999"],
      );
      assert.equal(state.tasks[0].specId, "spec-other");
      assert.equal(
        state.tasks.some((task) => task.id === "TSK-0002" || task.specId === "spec-checkin"),
        false,
      );
    });
  });
});

test("wireframe iframe is sandboxed without allow-same-origin+allow-scripts", async () => {
  await withStore(async ({ dir, store }) => {
    const spec = await store.readSpec("spec-checkin");
    await store.writeSpec({ ...spec.data, wireframesIndex: "wireframes/INDEX.html" }, spec.body);
    const wfDir = join(dir, ".legion-cli", "specs", "spec-checkin", "wireframes");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "INDEX.html"), "<html><body>wireframe</body></html>\n");
    await withServer(dir, async ({ handle }) => {
      const res = await fetch(`${handle.url}/spec`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assertHtmlOmitsToken(html, handle.token);
      assertSandboxedIframe(html);
    });
  });
});

test("open is opt-in; default does not spawn a browser", async () => {
  await withTempDir(async (dir) => {
    await withServer(
      dir,
      async ({ handle, opened }) => {
        assert.equal(opened.length, 1);
        assert.equal(opened[0], handle.url);
      },
      { open: true },
    );
  });
});

test("startServe routes GET/POST/DELETE /mcp inside one handle", async () => {
  const src = await readFile(join(pkgRoot, "src", "server.ts"), "utf8");
  assert.equal([...src.matchAll(/createServer\(/g)].length, 1);
  assert.doesNotMatch(src, /server\.on\(\s*["']request["']/);
  assert.match(src, /pathname === MCP_PATH/);

  await withTempDir(async (dir) => {
    const methods = [];
    const handle = await startDashboard({
      projectRoot: dir,
      port: 0,
      open: false,
      warn: () => {},
      occupy: true,
      mcpHttp: true,
      handleMcpHttp: async ({ req, res }) => {
        methods.push(req.method);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.end(": ok\n\n");
      },
    });
    try {
      const get = await fetch(`${handle.url}/mcp`, { headers: { Accept: "text/event-stream" } });
      assert.equal(get.status, 200);
      assert.match(get.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.notEqual(get.status, 405);
      const post = await fetch(`${handle.url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(post.status, 200);
      assert.notEqual(post.status, 403);
      const del = await fetch(`${handle.url}/mcp`, { method: "DELETE" });
      assert.equal(del.status, 200);
      assert.deepEqual(methods.sort(), ["DELETE", "GET", "POST"]);

      const origin = originFor(handle);
      const opt = await fetch(`${handle.url}/mcp`, { method: "OPTIONS", headers: { Origin: origin } });
      assert.equal(opt.status, 204);
      assert.match(opt.headers.get("allow") ?? "", /DELETE/);
      assert.match(opt.headers.get("access-control-allow-methods") ?? "", /DELETE/);
    } finally {
      await handle.close();
    }
  });
});

test("startServe refuses MCP HTTP on --expose; close does not hang on open SSE", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () =>
        startDashboard({
          projectRoot: dir,
          host: "0.0.0.0",
          port: 0,
          open: false,
          warn: () => {},
          occupy: true,
          mcpHttp: true,
          handleMcpHttp: async ({ res }) => {
            res.statusCode = 200;
            res.end();
          },
        }),
      (err) => {
        assert.match(String(err.message), /loopback-only|unauthenticated \/mcp/);
        assert.match(String(err.nextHint ?? ""), /--no-mcp-http --expose/);
        return true;
      },
    );

    const handle = await startDashboard({
      projectRoot: dir,
      port: 0,
      open: false,
      warn: () => {},
      occupy: true,
      mcpHttp: true,
      handleMcpHttp: async ({ res }) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.write(": hang\n\n");
      },
    });
    const sse = fetch(`${handle.url}/mcp`, { headers: { Accept: "text/event-stream" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.race([
      handle.close(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("close hung with GET SSE open")), 2000);
      }),
    ]);
    await sse.catch(() => undefined);
  });
});

test("second startServe while pid is live refuses; dead pid is overwritten", async () => {
  await withTempDir(async (dir) => {
    const first = await startDashboard({
      projectRoot: dir,
      port: 0,
      open: false,
      warn: () => {},
      occupy: true,
      mcpHttp: false,
    });
    try {
      const occupancy = ServeFileSchema.parse(
        JSON.parse(await readFile(join(dir, ".legion-cli", "serve.json"), "utf8")),
      );
      assert.equal(occupancy.pid, process.pid);
      assert.equal(occupancy.port, first.port);
      assert.equal(occupancy.bind, "127.0.0.1");
      assert.equal(occupancy.mcpPath, "/mcp");
      assert.equal(occupancy.mcpHttp, false);
      assert.match(occupancy.tokenSha256, /^[a-f0-9]{64}$/);
      await assert.rejects(
        () =>
          startDashboard({
            projectRoot: dir,
            port: 0,
            open: false,
            warn: () => {},
            occupy: true,
            mcpHttp: false,
          }),
        (err) => {
          assert.match(String(err.message), /already running/);
          return true;
        },
      );
    } finally {
      await first.close();
    }

    const servePath = join(dir, ".legion-cli", "serve.json");
    await mkdir(join(dir, ".legion-cli"), { recursive: true });
    await writeFile(
      servePath,
      `${JSON.stringify({
        schemaVersion: "legion-cli-serve/v1",
        port: 7420,
        bind: "127.0.0.1",
        mcpPath: "/mcp",
        mcpHttp: false,
        tokenSha256: "a".repeat(64),
        startedAt: new Date().toISOString(),
        pid: 1_000_000_000,
      })}\n`,
    );
    const revived = await startDashboard({
      projectRoot: dir,
      port: 0,
      open: false,
      warn: () => {},
      occupy: true,
      mcpHttp: false,
    });
    try {
      const written = ServeFileSchema.parse(JSON.parse(await readFile(servePath, "utf8")));
      assert.equal(written.pid, process.pid);
      assert.equal(written.port, revived.port);
      assert.equal(written.mcpPath, "/mcp");
    } finally {
      await revived.close();
    }
  });
});

test("occupy refuses corrupt serve.json instead of overwriting it", async () => {
  await withTempDir(async (dir) => {
    const servePath = join(dir, ".legion-cli", "serve.json");
    await mkdir(join(dir, ".legion-cli"), { recursive: true });
    await writeFile(servePath, "{not-json", "utf8");
    await assert.rejects(
      () =>
        startDashboard({
          projectRoot: dir,
          port: 0,
          open: false,
          warn: () => {},
          occupy: true,
          mcpHttp: false,
        }),
      (err) => {
        assert.match(String(err.message), /unreadable serve\.json/);
        return true;
      },
    );
    assert.equal(await readFile(servePath, "utf8"), "{not-json");
  });
});

test("EADDRINUSE Next is legion-cli serve --port <n>", async () => {
  await withTempDir(async (dir) => {
    const first = await startDashboard({
      projectRoot: dir,
      port: 0,
      open: false,
      warn: () => {},
    });
    try {
      await withTempDir(async (other) => {
        await assert.rejects(
          () =>
            startDashboard({
              projectRoot: other,
              port: first.port,
              open: false,
              warn: () => {},
            }),
          (err) => {
            assert.match(String(err.message), /already in use/);
            assert.equal(err.nextHint, `legion-cli serve --port ${first.port + 1}`);
            return true;
          },
        );
      });
    } finally {
      await first.close();
    }
  });
});

test("POST /engine/ticket over 64 KiB is 413", async () => {
  await withStore(async ({ dir }) => {
    await withServer(dir, async ({ handle }) => {
      const url = new URL(`${handle.url}/engine/ticket`);
      const origin = originFor(handle);
      const huge = await new Promise((resolve, reject) => {
        let status;
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: origin,
              "X-Legion-Cli-Token": handle.token,
              "Transfer-Encoding": "chunked",
            },
          },
          (res) => {
            status = res.statusCode;
            res.resume();
            res.on("end", () => resolve(status));
          },
        );
        req.on("error", (err) => {
          if (status === 413) {
            resolve(413);
            return;
          }
          reject(err);
        });
        req.write(Buffer.alloc(64 * 1024 + 1, 0x78));
        req.end();
      });
      assert.equal(huge, 413);
    });
  });
});

test("WEBMCP_SCRIPT is DOM-only UI tools, not a polyfill", () => {
  assert.equal(WEBMCP_SCRIPT_PATH, "/webmcp.js");
  assert.deepEqual(WEBMCP_TOOLS, ["filter_board", "open_task", "show_timeline", "highlight_blockers"]);
  assert.doesNotMatch(WEBMCP_SCRIPT, /fetch\(/);
  assert.doesNotMatch(WEBMCP_SCRIPT, /XMLHttpRequest/);
  assert.doesNotMatch(WEBMCP_SCRIPT, /\/engine\//);
  assert.match(WEBMCP_SCRIPT, /document\.modelContext/);
  assert.match(WEBMCP_SCRIPT, /if \(typeof registerTool !== "function"\) return/);
  for (const name of WEBMCP_TOOLS) {
    assert.match(WEBMCP_SCRIPT, new RegExp(`name: "${name}"`));
  }
  assert.match(WEBMCP_SCRIPT, /readOnlyHint: true/);
});

test("flags.webmcp default false: /webmcp.js is 404 and HTML has no script", async () => {
  await withStore(async ({ dir }) => {
    const configPath = join(dir, ".legion-cli", "config.yaml");
    const config = await readFile(configPath, "utf8");
    assert.doesNotMatch(config, /webmcp:\s*true/);
    await withServer(dir, async ({ handle }) => {
      assert.equal(handle.webmcp, false);
      const board = await fetch(handle.url);
      assert.equal(board.status, 200);
      const html = await board.text();
      assert.doesNotMatch(html, /webmcp\.js/);
      assert.doesNotMatch(html, /<script/);
      assertHtmlOmitsToken(html, handle.token);
      assertWebmcpOffHeaders(board.headers);

      const script = await fetch(`${handle.url}${WEBMCP_SCRIPT_PATH}`);
      assert.equal(script.status, 404);
      assertWebmcpOffHeaders(script.headers);
    });
  });
});

test("webmcp on via opts or config: script, CSP script-src, COOP, no fetch, no token", async () => {
  await withStore(async ({ dir }) => {
    const configPath = join(dir, ".legion-cli", "config.yaml");
    const before = await readFile(configPath, "utf8");

    const assertOn = async ({ handle }) => {
      assert.equal(handle.webmcp, true);
      const board = await fetch(handle.url);
      assert.equal(board.status, 200);
      const html = await board.text();
      assert.match(html, /<script src="\/webmcp\.js" defer><\/script>/);
      assert.match(html, /id="timeline"/);
      assert.match(html, /id="blockers"/);
      const spec = await fetch(`${handle.url}/spec`);
      assert.doesNotMatch(await spec.text(), /webmcp\.js/);
      const graph = await fetch(`${handle.url}/graph`);
      assert.doesNotMatch(await graph.text(), /webmcp\.js/);
      const audit = await fetch(`${handle.url}/audit`);
      assert.doesNotMatch(await audit.text(), /webmcp\.js/);
      const wiki = await fetch(`${handle.url}/wiki`);
      assert.doesNotMatch(await wiki.text(), /webmcp\.js/);
      const missing = await fetch(`${handle.url}/no-such-page`);
      assert.doesNotMatch(await missing.text(), /webmcp\.js/);
      assertHtmlOmitsToken(html, handle.token);
      assertWebmcpHeaders(board.headers);

      const scriptRes = await fetch(`${handle.url}${WEBMCP_SCRIPT_PATH}`);
      assert.equal(scriptRes.status, 200);
      assert.match(scriptRes.headers.get("content-type") ?? "", /text\/javascript/);
      assertWebmcpHeaders(scriptRes.headers);
      const body = await scriptRes.text();
      assert.equal(body, WEBMCP_SCRIPT);
      assert.doesNotMatch(body, /fetch\(/);
      assert.doesNotMatch(body, /XMLHttpRequest/);
      assert.doesNotMatch(body, /\/engine\//);
      for (const name of WEBMCP_TOOLS) {
        assert.match(body, new RegExp(`name: "${name}"`));
      }
      assert.match(body, /readOnlyHint: true/);

      const noToken = await enginePost(handle, "/engine/ticket", { title: "park extra" });
      assert.equal(noToken.status, 403);
    };

    await withServer(dir, assertOn, { webmcp: true });
    assert.equal(await readFile(configPath, "utf8"), before);

    await enableConfigWebmcp(dir);
    await withServer(dir, assertOn);
  });
});

test("--expose + webmcp still omits write token from GET HTML", async () => {
  await withTempDir(async (dir) => {
    await withServer(
      dir,
      async ({ handle, warns }) => {
        assert.equal(handle.webmcp, true);
        assert.equal(handle.host, "0.0.0.0");
        const token = tokenFromWarns(warns);
        const res = await fetch(`http://127.0.0.1:${handle.port}/`);
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.match(html, /webmcp\.js/);
        assertHtmlOmitsToken(html, token);
        assertWebmcpHeaders(res.headers);
      },
      { host: "0.0.0.0", webmcp: true },
    );
  });
});
