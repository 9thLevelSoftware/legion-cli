import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { INDEX_DB_BASENAME, LOCK_BASENAME } from "@9thlevelsoftware/legion-cli-persist";
import { MCP_APP_MIME, MCP_APP_RESOURCES } from "../dist/index.js";
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

async function enableMcpApps(dir) {
  const path = join(dir, ".legion-cli", "config.yaml");
  const current = await readFile(path, "utf8");
  await writeFile(path, `${current.trimEnd()}\nflags:\n  mcpApps: true\n`, "utf8");
}

function htmlOf(contents) {
  const html = contents.find((item) => item.mimeType === MCP_APP_MIME);
  assert.ok(html, "expected MCP App HTML");
  return html;
}

function textOf(contents) {
  const plain = contents.find((item) => String(item.mimeType).startsWith("text/plain"));
  assert.ok(plain, "expected text fallback");
  return plain;
}

test("flags.mcpApps lists ui:// resources with CSP self and status text fallback", async () => {
  await withStore(async ({ dir }) => {
    await enableMcpApps(dir);
    await withClient(dir, async (client) => {
      assert.ok(client.getServerCapabilities()?.resources);
      const listed = await client.listResources();
      const uris = listed.resources.map((resource) => resource.uri).sort();
      assert.deepEqual(
        uris,
        MCP_APP_RESOURCES.map((resource) => resource.uri).slice().sort(),
      );
      for (const resource of listed.resources) {
        assert.equal(resource.mimeType, MCP_APP_MIME);
        assert.match(resource.uri, /^ui:\/\/legion-cli\//);
      }

      const tools = await client.listTools();
      const status = tools.tools.find((tool) => tool.name === "legion_cli_status");
      assert.equal(status?._meta?.ui?.resourceUri, "ui://legion-cli/dashboard");

      const dashboard = await client.readResource({ uri: "ui://legion-cli/dashboard" });
      const html = htmlOf(dashboard.contents);
      assert.match(html.text, /Kanban/);
      assert.match(html.text, /Read-only/);
      assert.doesNotMatch(html.text, /webmcp\.js/);
      assert.deepEqual(html._meta?.ui?.csp, {
        connectDomains: ["'self'"],
        resourceDomains: ["'self'"],
      });

      const fallback = textOf(dashboard.contents);
      assert.match(fallback.text, /phase: executing/);
      assert.match(fallback.text, /Current task: TSK-0002/);
      assert.match(fallback.text, /Run:\s+legion-cli/);

      const called = parseTool(await client.callTool({ name: "legion_cli_status", arguments: {} }));
      assert.equal(called.isError, false, called.text);
      assert.equal(called.json.phase, "executing");
    });
  });
});

test("mcpApps HTML does not rebuild the wiki index or take engine.lock", async () => {
  await withTempDir(async (dir) => {
    await copyFixtureProject(dir);
    await enableMcpApps(dir);
    const indexDir = join(dir, ".legion-cli", "index");
    const dbPath = join(indexDir, INDEX_DB_BASENAME);
    const lockPath = join(indexDir, LOCK_BASENAME);
    const statePath = join(dir, ".legion-cli", "STATE.md");
    const beforeState = await readFile(statePath, "utf8");

    await withClient(dir, async (client) => {
      const dashboard = await client.readResource({ uri: "ui://legion-cli/dashboard" });
      assert.match(htmlOf(dashboard.contents).text, /Kanban/);
    });

    assert.equal(await missing(indexDir), true);
    assert.equal(await missing(dbPath), true);
    assert.equal(await missing(lockPath), true);
    assert.equal(await readFile(statePath, "utf8"), beforeState);
  });
});
