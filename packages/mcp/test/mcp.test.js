import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { MCP_TOOLS } from "../dist/index.js";
import { parseTool, withClient, withStore, withTempDir } from "./helpers.js";

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
        for (const banned of WRITE_TOOLS) {
          assert.doesNotMatch(tool.name, new RegExp(banned, "i"));
        }
      }
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

      const graph = parseTool(await client.callTool({ name: "legion_cli_task_graph", arguments: {} }));
      assert.equal(graph.isError, false, graph.text);
      assert.equal(graph.json.specId, "spec-checkin");
      assert.equal(graph.json.tasks.length, 1);
      assert.equal(graph.json.tasks[0].id, "TSK-0002");
      assert.deepEqual(graph.json.tasks[0].blockedBy, ["TSK-0001"]);

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

  await withStore(async ({ dir }) => {
    const statePath = join(dir, ".legion-cli", "STATE.md");
    const wikiPath = join(dir, ".legion-cli", "wiki", "README.md");
    const beforeState = await readFile(statePath, "utf8");
    const beforeWiki = await readFile(wikiPath, "utf8");
    const beforeMtime = (await stat(statePath)).mtimeMs;

    await withClient(dir, async (client) => {
      await client.callTool({ name: "legion_cli_status", arguments: {} });
      await client.callTool({ name: "legion_cli_brief", arguments: {} });
      await client.callTool({ name: "legion_cli_search", arguments: { q: "Wiki" } });
      await client.callTool({ name: "legion_cli_show", arguments: { page: "product/intent" } });
      await client.callTool({ name: "legion_cli_task_graph", arguments: {} });
      await client.callTool({ name: "legion_cli_current_task", arguments: {} });
      await client.callTool({ name: "legion_cli_audit_trail", arguments: {} });
      await client.callTool({
        name: "legion_cli_wiki_backlinks",
        arguments: { page: "product/intent" },
      });
    });

    assert.equal(await readFile(statePath, "utf8"), beforeState);
    assert.equal(await readFile(wikiPath, "utf8"), beforeWiki);
    assert.equal((await stat(statePath)).mtimeMs, beforeMtime);
  });
});

