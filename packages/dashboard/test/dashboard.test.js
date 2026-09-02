import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startDashboard } from "../dist/index.js";
import { todoTask, withStore, withTempDir } from "./helpers.js";

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

function tokenFromHtml(html) {
  const match = /<meta name="legion-cli-token" content="([^"]+)">/.exec(html);
  assert.ok(match, "expected legion-cli-token meta");
  return match[1];
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
  assert.doesNotMatch(server, /\.execute\(/);
  assert.doesNotMatch(server, /Set-Cookie|set-cookie|cookie=/);
});

test("binds 127.0.0.1, GET kanban/spec/graph/audit/api/state, origin allowlist, token meta", async () => {
  await withStore(async ({ dir, store }) => {
    await store.writeTask(todoTask(), "Show on the board before execute.\n");
    await withServer(dir, async ({ handle, opened }) => {
      assert.equal(handle.host, "127.0.0.1");
      assert.equal(opened.length, 0);
      assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);

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
      assert.match(html, /<meta name="legion-cli-token" content="[0-9a-f]{64}">/);
      assert.equal(board.headers.get("access-control-allow-origin"), null);
      assert.equal(board.headers.get("set-cookie"), null);
      assert.equal(board.headers.get("content-security-policy")?.includes("connect-src 'self'"), true);

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
    await withServer(dir, async ({ handle }) => {
      const html = await (await fetch(handle.url)).text();
      const token = tokenFromHtml(html);
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

      const ship = await enginePost(handle, "/engine/ship", {}, { token });
      assert.equal(ship.status, 404);

      const ticketRes = await enginePost(handle, "/engine/ticket", { title: "park extra from board" }, { token });
      assert.equal(ticketRes.status, 200, await ticketRes.clone().text());
      assert.equal(ticketRes.headers.get("access-control-allow-origin"), origin);
      assert.notEqual(ticketRes.headers.get("access-control-allow-origin"), "*");
      const ticketBody = await ticketRes.json();
      assert.equal(ticketBody.ok, true);
      assert.match(ticketBody.id, /^TSK-\d+$/);
      const filed = await store.readTask(ticketBody.id);
      assert.equal(filed.data.title, "park extra from board");
      assert.equal(filed.data.specId, "spec-checkin");

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
      while (!chunk.includes("event: state")) {
        const { value, done } = await reader.read();
        if (done) break;
        chunk += decoder.decode(value, { stream: true });
      }
      assert.match(chunk, /event: state/);
      assert.match(chunk, /"readOnly":true/);
      await reader.cancel();
    });
  });
});

test("--expose binds 0.0.0.0 and warns", async () => {
  await withTempDir(async (dir) => {
    await withServer(
      dir,
      async ({ handle, warns }) => {
        assert.equal(handle.host, "0.0.0.0");
        assert.match(warns.join("\n"), /0\.0\.0\.0/);
        const res = await fetch(`http://127.0.0.1:${handle.port}/`);
        assert.equal(res.status, 200);
        assert.match(await res.text(), /uninitialized/);
      },
      { host: "0.0.0.0" },
    );
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
