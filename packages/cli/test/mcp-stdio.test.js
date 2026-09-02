import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MCP_TOOLS } from "@9thlevelsoftware/legion-cli-mcp";
import { LegionStore } from "@9thlevelsoftware/legion-cli-persist";
import { bin, normalize, runCli, withTempDir } from "./helpers.js";

const persistFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "persist",
  "test",
  "fixtures",
  "project",
);

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitForId(child, id, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for rpc id=${id} stderr=${stderr}`));
    }, timeoutMs);
    const onOut = (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.id === id) {
          cleanup();
          resolve(parsed);
        }
      }
    };
    const onErr = (chunk) => {
      stderr += chunk;
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`mcp exited early code=${code} signal=${signal} stderr=${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onOut);
      child.stderr.off("data", onErr);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onOut);
    child.stderr.on("data", onErr);
    child.on("exit", onExit);
  });
}

test("mcp --help still exits 0 without hanging", () => {
  const result = runCli(["mcp", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(normalize(result.stdout), /read-only/i);
});

test("legion-cli mcp stdio lists tools then exits when stdin closes", async () => {
  await withTempDir(async (dir) => {
    await cp(join(persistFixture, "legion-cli"), join(dir, ".legion-cli"), { recursive: true });
    const store = new LegionStore(dir);
    await store.rebuild();

    const child = spawn(process.execPath, [bin, "mcp", "--project", dir], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legion-cli-mcp-test", version: "0.0.0" },
        },
      });
      const initialized = await waitForId(child, 1);
      assert.equal(initialized.error, undefined, JSON.stringify(initialized));
      assert.ok(initialized.result?.serverInfo);

      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
      send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const listed = await waitForId(child, 2);
      assert.equal(listed.error, undefined, JSON.stringify(listed));
      const names = listed.result.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [...MCP_TOOLS].sort());

      const exited = new Promise((resolve, reject) => {
        child.once("exit", (code, signal) => {
          if (code === 0) resolve(code);
          else reject(new Error(`mcp exit code=${code} signal=${signal}`));
        });
      });
      child.stdin.end();
      assert.equal(await exited, 0);
    } finally {
      clearTimeout(killer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
