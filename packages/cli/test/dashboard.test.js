import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { bin, normalize, runCli, withTempDir } from "./helpers.js";

function startDashboardCli(args) {
  const child = spawn(process.execPath, [bin, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`dashboard did not print Viewer url\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15_000);
    const onData = () => {
      const match = /Viewer: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", onData);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (code) {
        clearTimeout(timer);
        reject(new Error(`dashboard exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });
  return { child, url, getStdout: () => stdout, getStderr: () => stderr };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function tokenFromStderr(stderr) {
  const match = /Write token: ([0-9a-f]{64})/.exec(stderr);
  assert.ok(match, `expected write token on stderr\n${stderr}`);
  return match[1];
}

test("dashboard --no-open --port 0 serves GET / and optional engine POSTs", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const { child, url, getStderr, getStdout } = startDashboardCli([
      "dashboard",
      "--project",
      dir,
      "--no-open",
      "--port",
      "0",
    ]);
    try {
      const viewer = await url;
      const token = tokenFromStderr(getStderr());
      assert.doesNotMatch(getStdout(), new RegExp(token));
      const res = await fetch(viewer);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /source of truth/);
      assert.match(html, /Read-only viewer/);
      assert.match(html, /Checkin/);
      assert.match(html, /Kanban/);
      assert.doesNotMatch(html, /legion-cli-token/);
      assert.equal(html.includes(token), false);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
      assert.equal(res.headers.get("set-cookie"), null);

      const noToken = await fetch(`${viewer}/engine/wikiTrust`, {
        method: "POST",
        headers: { Origin: viewer, "Content-Type": "application/json" },
        body: JSON.stringify({ pageId: "README" }),
      });
      assert.equal(noToken.status, 403);

      const execute = await fetch(`${viewer}/engine/execute`, {
        method: "POST",
        headers: {
          Origin: viewer,
          "Content-Type": "application/json",
          "X-Legion-Cli-Token": token,
        },
        body: JSON.stringify({}),
      });
      assert.equal(execute.status, 404);

      const trust = await fetch(`${viewer}/engine/wikiTrust`, {
        method: "POST",
        headers: {
          Origin: viewer,
          "Content-Type": "application/json",
          "X-Legion-Cli-Token": token,
        },
        body: JSON.stringify({ pageId: "README" }),
      });
      assert.equal(trust.status, 200, await trust.clone().text());
      const body = await trust.json();
      assert.equal(body.ok, true);
      assert.equal(body.trust, "reviewed");
    } finally {
      await stop(child);
    }
  });
});

test("dashboard --json prints the write token; GET HTML omits it", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const child = spawn(process.execPath, [bin, "dashboard", "--project", dir, "--no-open", "--port", "0", "--json"], {
      encoding: "utf8",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const payload = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`dashboard --json did not print startup JSON\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 15_000);
      const tryParse = () => {
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.url && parsed.token) {
            clearTimeout(timer);
            resolve(parsed);
          }
        } catch {
          // incomplete JSON
        }
      };
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        tryParse();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        if (code) {
          clearTimeout(timer);
          reject(new Error(`dashboard exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }
      });
    });
    try {
      assert.match(payload.token, /^[0-9a-f]{64}$/);
      assert.equal(tokenFromStderr(stderr), payload.token);
      const res = await fetch(payload.url);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.doesNotMatch(html, /legion-cli-token/);
      assert.equal(html.includes(payload.token), false);
    } finally {
      await stop(child);
    }
  });
});

test("dashboard --expose warns and still serves loopback GET without the token", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const { child, url, getStderr } = startDashboardCli([
      "dashboard",
      "--project",
      dir,
      "--no-open",
      "--port",
      "0",
      "--expose",
    ]);
    try {
      const viewer = await url;
      const stderr = normalize(getStderr());
      assert.match(stderr, /0\.0\.0\.0/);
      assert.match(stderr, /not in GET HTML/);
      const token = tokenFromStderr(stderr);
      const res = await fetch(viewer);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.doesNotMatch(html, /legion-cli-token/);
      assert.equal(html.includes(token), false);
    } finally {
      await stop(child);
    }
  });
});
