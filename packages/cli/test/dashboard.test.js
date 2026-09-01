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

test("dashboard --no-open --port 0 serves GET / and rejects POST", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const { child, url } = startDashboardCli([
      "dashboard",
      "--project",
      dir,
      "--no-open",
      "--port",
      "0",
    ]);
    try {
      const viewer = await url;
      const res = await fetch(viewer);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /Read-only/);
      assert.match(html, /Checkin/);
      assert.match(html, /Kanban/);
      const post = await fetch(viewer, { method: "POST", body: "{}" });
      assert.equal(post.status, 405);
    } finally {
      await stop(child);
    }
  });
});

test("dashboard --expose warns and still serves loopback GET", async () => {
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
      assert.match(normalize(getStderr()), /0\.0\.0\.0/);
      const res = await fetch(viewer);
      assert.equal(res.status, 200);
    } finally {
      await stop(child);
    }
  });
});
