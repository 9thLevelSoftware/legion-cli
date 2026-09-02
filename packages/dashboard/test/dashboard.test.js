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

test("package is read-only: no core/execute dependency and no POST export", async () => {
  const pkg = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "@9thlevelsoftware/legion-cli-dashboard");
  assert.equal(pkg.dependencies["@9thlevelsoftware/legion-cli-core"], undefined);
  assert.ok(pkg.dependencies["@9thlevelsoftware/legion-cli-persist"]);
  assert.ok(pkg.dependencies["@9thlevelsoftware/legion-cli-graph"]);
  assert.ok(pkg.dependencies["@9thlevelsoftware/legion-cli-wiki"]);
  const index = await readFile(join(pkgRoot, "src", "index.ts"), "utf8");
  const server = await readFile(join(pkgRoot, "src", "server.ts"), "utf8");
  assert.doesNotMatch(index, /legion-cli-core/);
  assert.doesNotMatch(server, /createLegionEngine|execute\(/);
});

test("binds 127.0.0.1, GET kanban/spec/graph/audit/api/state, no POST, origin allowlist", async () => {
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
      assert.match(html, /Read-only/);
      assert.doesNotMatch(html, /webmcp\.js|modelContext|registerTool/);
      assert.equal(board.headers.get("access-control-allow-origin"), null);
      assert.equal(board.headers.get("content-security-policy")?.includes("connect-src 'self'"), true);
      assert.equal(board.headers.get("content-security-policy")?.includes("script-src"), false);
      assert.equal(board.headers.get("cross-origin-opener-policy"), null);
      assert.equal(board.headers.get("cross-origin-embedder-policy"), null);
      const scriptOff = await fetch(`${handle.url}/webmcp.js`);
      assert.equal(scriptOff.status, 404);

      const allowedOrigin = originFor(handle);
      const allowed = await fetch(handle.url, { headers: { Origin: allowedOrigin } });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get("access-control-allow-origin"), allowedOrigin);
      assert.notEqual(allowed.headers.get("access-control-allow-origin"), "*");

      const denied = await fetch(handle.url, { headers: { Origin: "http://evil.example" } });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("access-control-allow-origin"), null);

      const post = await fetch(handle.url, { method: "POST", body: "{}" });
      assert.equal(post.status, 405);
      assert.match(post.headers.get("allow") ?? "", /GET/);

      const enginePost = await fetch(`${handle.url}/api/state`, { method: "POST", body: "{}" });
      assert.equal(enginePost.status, 405);

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

async function enableWebmcp(dir) {
  const path = join(dir, ".legion-cli", "config.yaml");
  const current = await readFile(path, "utf8");
  await writeFile(path, `${current.trimEnd()}\nflags:\n  webmcp: true\n`, "utf8");
}

test("flags.webmcp serves COOP/COEP and feature-detects registerTool; page tools are UI-only", async () => {
  await withStore(async ({ dir, store }) => {
    await store.writeTask(todoTask(), "Show on the board before execute.\n");
    await enableWebmcp(dir);
    await withServer(dir, async ({ handle }) => {
      const board = await fetch(handle.url);
      assert.equal(board.status, 200);
      assert.equal(board.headers.get("cross-origin-opener-policy"), "same-origin");
      assert.equal(board.headers.get("cross-origin-embedder-policy"), "require-corp");
      assert.equal(board.headers.get("origin-agent-cluster"), "?1");
      assert.equal(board.headers.get("content-security-policy")?.includes("script-src 'self'"), true);
      const html = await board.text();
      assert.match(html, /Kanban/);
      assert.match(html, /TSK-0003/);
      assert.match(html, /id="timeline"/);
      assert.match(html, /id="blockers"/);
      assert.match(html, /<script src="\/webmcp\.js" defer><\/script>/);
      assert.doesNotMatch(html, /modelContext\s*=/);

      const script = await fetch(`${handle.url}/webmcp.js`);
      assert.equal(script.status, 200);
      const js = await script.text();
      assert.match(js, /document\.modelContext/);
      assert.match(js, /registerTool/);
      assert.doesNotMatch(js, /polyfill/i);
      for (const name of ["filter_board", "open_task", "show_timeline", "highlight_blockers"]) {
        assert.match(js, new RegExp(`name:\\s*"${name}"`));
      }
      assert.match(js, /readOnlyHint:\s*true/);
      assert.match(js, /typeof registerTool !== "function"/);
      assert.match(js, /catch/);
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
