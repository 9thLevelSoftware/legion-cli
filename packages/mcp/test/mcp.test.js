import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { INDEX_DB_BASENAME, LOCK_BASENAME } from "@9thlevelsoftware/legion-cli-persist";
import { MCP_TOOLS } from "../dist/index.js";
import { copyFixtureProject, parseTool, withClient, withStore, withTempDir } from "./helpers.js";

async function missing(path) {
  try {
    await stat(path);
    return false;
  } catch (err) {
    if (err.code === "ENOENT") return true;
    throw err;
  }
}

const WRITE_TOOLS = ["init", "create", "execute", "plan", "ship", "ingest", "trust", "amend"];

test("exposes exactly the read-only tools", async () => {
  await withStore(async ({ dir }) => {
    await withClient(dir, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [...MCP_TOOLS].sort());
      for (const tool of listed.tools) {
        assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
        assert.equal(tool.annotations?.destructiveHint, false, tool.name);
        assert.equal(tool._meta?.ui, undefined, tool.name);
        for (const banned of WRITE_TOOLS) {
          assert.doesNotMatch(tool.name, new RegExp(banned, "i"));
        }
      }
      assert.equal(client.getServerCapabilities()?.resources, undefined);
    });
  });
});

test("status, current task, task graph, brief, show, search, backlinks", async () => {
  await withStore(async ({ dir }) => {
    await withClient(dir, async (client) => {
      const status = parseTool(await client.callTool({ name: "legion_cli_status", arguments: {} }));
      assert.equal(status.isError, false, status.text);
      assert.equal(status.json.phase, "executing");
      assert.equal(status.json.name, "Checkin");
      assert.equal(status.json.currentTaskId, "TSK-0002");
      assert.equal(status.json.activeSpecId, "spec-checkin");

      const current = parseTool(await client.callTool({ name: "legion_cli_current_task", arguments: {} }));
      assert.equal(current.isError, false, current.text);
      assert.equal(current.json.currentTask.id, "TSK-0002");
      assert.equal(current.json.currentTask.title, "in/out button");
      assert.equal(current.json.currentTask.adapter, undefined);

      const graph = parseTool(await client.callTool({ name: "legion_cli_task_graph", arguments: {} }));
      assert.equal(graph.isError, false, graph.text);
      assert.equal(graph.json.specId, "spec-checkin");
      assert.equal(graph.json.tasks.length, 1);
      assert.equal(graph.json.tasks[0].id, "TSK-0002");
      assert.deepEqual(graph.json.tasks[0].blockedBy, ["TSK-0001"]);
      assert.equal(graph.json.tasks[0].adapter, undefined);
      assert.equal("adapter" in graph.json.tasks[0], false);

      const brief = parseTool(await client.callTool({ name: "legion_cli_brief", arguments: {} }));
      assert.equal(brief.isError, false, brief.text);
      assert.equal(brief.json.project.name, "Checkin");
      assert.equal(brief.json.phase, "executing");
      assert.equal(brief.json.currentTask.id, "TSK-0002");

      const shown = parseTool(
        await client.callTool({ name: "legion_cli_show", arguments: { page: "product/intent" } }),
      );
      assert.equal(shown.isError, false, shown.text);
      assert.equal(shown.json.kind, "wiki");
      assert.match(shown.json.body, /Teammates tap/);

      const search = parseTool(
        await client.callTool({ name: "legion_cli_search", arguments: { q: "Teammates tap" } }),
      );
      assert.equal(search.isError, false, search.text);
      assert.ok(search.json.some((hit) => hit.id === "product/intent" || hit.title === "Intent"));

      const backlinks = parseTool(
        await client.callTool({
          name: "legion_cli_wiki_backlinks",
          arguments: { page: "product/intent" },
        }),
      );
      assert.equal(backlinks.isError, false, backlinks.text);
      assert.ok(backlinks.json.backlinks.some((link) => link.id === "README"));
    });
  });
});

test("task graph and current task pass through raw Task.adapter when set", async () => {
  await withStore(async ({ dir, store }) => {
    const doc = await store.readTask("TSK-0002");
    await store.writeTask({ ...doc.data, adapter: "grok" }, doc.body);
    await withClient(dir, async (client) => {
      const current = parseTool(await client.callTool({ name: "legion_cli_current_task", arguments: {} }));
      assert.equal(current.isError, false, current.text);
      assert.equal(current.json.currentTask.id, "TSK-0002");
      assert.equal(current.json.currentTask.adapter, "grok");

      const graph = parseTool(await client.callTool({ name: "legion_cli_task_graph", arguments: {} }));
      assert.equal(graph.isError, false, graph.text);
      assert.equal(graph.json.tasks.length, 1);
      assert.equal(graph.json.tasks[0].id, "TSK-0002");
      assert.equal(graph.json.tasks[0].adapter, "grok");
    });
  });
});

test("audit trail reads events.jsonl and is empty when missing", async () => {
  await withStore(async ({ dir }) => {
    await withClient(dir, async (client) => {
      const empty = parseTool(await client.callTool({ name: "legion_cli_audit_trail", arguments: {} }));
      assert.equal(empty.isError, false, empty.text);
      assert.deepEqual(empty.json, []);
    });

    await mkdir(join(dir, ".legion-cli", "audit"), { recursive: true });
    await writeFile(
      join(dir, ".legion-cli", "audit", "events.jsonl"),
      `${JSON.stringify({
        schemaVersion: "legion-cli-audit/v1",
        ts: "2026-09-01T12:00:00.000Z",
        type: "plan",
        phase: "plan_ready",
        taskId: null,
        actor: "cli",
        data: { readiness: "PASS" },
      })}\n`,
      "utf8",
    );

    await withClient(dir, async (client) => {
      const trail = parseTool(await client.callTool({ name: "legion_cli_audit_trail", arguments: {} }));
      assert.equal(trail.isError, false, trail.text);
      assert.equal(trail.json.length, 1);
      assert.equal(trail.json[0].type, "plan");
      assert.equal(trail.json[0].phase, "plan_ready");
    });
  });
});

async function callAllReadTools(client) {
  return {
    status: parseTool(await client.callTool({ name: "legion_cli_status", arguments: {} })),
    brief: parseTool(await client.callTool({ name: "legion_cli_brief", arguments: {} })),
    search: parseTool(await client.callTool({ name: "legion_cli_search", arguments: { q: "Wiki" } })),
    show: parseTool(await client.callTool({ name: "legion_cli_show", arguments: { page: "product/intent" } })),
    graph: parseTool(await client.callTool({ name: "legion_cli_task_graph", arguments: {} })),
    current: parseTool(await client.callTool({ name: "legion_cli_current_task", arguments: {} })),
    audit: parseTool(await client.callTool({ name: "legion_cli_audit_trail", arguments: {} })),
    backlinks: parseTool(
      await client.callTool({ name: "legion_cli_wiki_backlinks", arguments: { page: "product/intent" } }),
    ),
  };
}

test("tools refuse until init and do not write project state", async () => {
  await withTempDir(async (dir) => {
    await withClient(dir, async (client) => {
      const status = parseTool(await client.callTool({ name: "legion_cli_status", arguments: {} }));
      assert.equal(status.isError, false, status.text);
      assert.equal(status.json.phase, "uninitialized");

      const brief = parseTool(await client.callTool({ name: "legion_cli_brief", arguments: {} }));
      assert.equal(brief.isError, true);
      assert.match(brief.text, /until init/);
    });
  });
});

test("missing wiki index is not rebuilt and does not take engine.lock", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    const indexDir = join(dir, ".legion-cli", "index");
    const dbPath = join(indexDir, INDEX_DB_BASENAME);
    const lockPath = join(indexDir, LOCK_BASENAME);
    const statePath = join(dir, ".legion-cli", "STATE.md");
    const wikiPath = join(dir, ".legion-cli", "wiki", "README.md");
    const beforeState = await readFile(statePath, "utf8");
    const beforeWiki = await readFile(wikiPath, "utf8");

    await withClient(dir, async (client) => {
      const results = await callAllReadTools(client);
      assert.equal(results.status.isError, false, results.status.text);
      assert.equal(results.graph.isError, false, results.graph.text);
      assert.equal(results.current.isError, false, results.current.text);
      assert.equal(results.audit.isError, false, results.audit.text);
      assert.equal(results.brief.isError, true);
      assert.match(results.brief.text, /index rebuild/);
      assert.equal(results.search.isError, true);
      assert.match(results.search.text, /index rebuild/);
      assert.equal(results.show.isError, true);
      assert.match(results.show.text, /index rebuild/);
      assert.equal(results.backlinks.isError, true);
      assert.match(results.backlinks.text, /index rebuild/);
    });

    assert.equal(await missing(indexDir), true);
    assert.equal(await missing(dbPath), true);
    assert.equal(await missing(lockPath), true);
    assert.equal(await readFile(statePath, "utf8"), beforeState);
    assert.equal(await readFile(wikiPath, "utf8"), beforeWiki);
  });
});

test("prebuilt index is not rewritten and lock is not taken", async () => {
  await withStore(async ({ dir }) => {
    const statePath = join(dir, ".legion-cli", "STATE.md");
    const wikiPath = join(dir, ".legion-cli", "wiki", "README.md");
    const tasksPath = join(dir, ".legion-cli", "tasks", "TSK-0002.md");
    const dbPath = join(dir, ".legion-cli", "index", INDEX_DB_BASENAME);
    const lockPath = join(dir, ".legion-cli", "index", LOCK_BASENAME);
    const beforeState = await readFile(statePath, "utf8");
    const beforeWiki = await readFile(wikiPath, "utf8");
    const beforeTask = await readFile(tasksPath, "utf8");
    const beforeDb = await readFile(dbPath);
    const beforeDbMtime = (await stat(dbPath)).mtimeMs;
    const lockMissingBefore = await missing(lockPath);
    const beforeLockMtime = lockMissingBefore ? null : (await stat(lockPath)).mtimeMs;

    await withClient(dir, async (client) => {
      const results = await callAllReadTools(client);
      assert.equal(results.status.isError, false, results.status.text);
      assert.equal(results.brief.isError, false, results.brief.text);
      assert.equal(results.search.isError, false, results.search.text);
      assert.equal(results.show.isError, false, results.show.text);
      assert.equal(results.backlinks.isError, false, results.backlinks.text);
    });

    assert.equal(await readFile(statePath, "utf8"), beforeState);
    assert.equal(await readFile(wikiPath, "utf8"), beforeWiki);
    assert.equal(await readFile(tasksPath, "utf8"), beforeTask);
    assert.deepEqual(await readFile(dbPath), beforeDb);
    assert.equal((await stat(dbPath)).mtimeMs, beforeDbMtime);
    if (lockMissingBefore) {
      assert.equal(await missing(lockPath), true);
    } else {
      assert.equal((await stat(lockPath)).mtimeMs, beforeLockMtime);
    }
  });
});

