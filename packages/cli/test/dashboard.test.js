import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
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

/** A focused project at plan_ready with an adapter-default assurance draft. */
async function seedAssuranceReady(dir) {
  const engine = createLegionEngine(dir);
  await engine.init({ name: "Checkin", adapter: "fake", workflowProfile: "focused" });
  await engine.store.writeSpec({
    schemaVersion: "legion-cli-spec/v1", id: "spec-checkin", title: "Office check-in", status: "frozen",
    mustBeTrue: ["People can tap in or out on their phone in under five seconds"], mustNotChange: ["auth"], outOfScope: ["payroll"],
    acceptance: [{ id: "AC-01", statement: "Tap in or out on a phone completes in under five seconds", kind: "behavior", priority: "P0" }],
    personas: ["teammates"], happyPath: "Open the board, tap In.", frozenAt: "2026-09-01T12:00:00.000Z", frozenBy: "tester",
  }, "Spec body.\n");
  const project = await engine.store.readProject();
  await engine.store.writeProject({ ...project.data, activeSpecId: "spec-checkin" }, project.body);
  await engine.store.writeTask({
    schemaVersion: "legion-cli-task/v1", id: "TSK-0001", title: "in/out button", status: "ready", type: "feature", priority: "P0",
    specId: "spec-checkin", blockedBy: [], blocks: [], assignee: "agent", notes: "",
    contract: { filesAllowed: ["src/main.ts"], filesForbidden: [".git/**"], expectedArtifacts: ["src/main.ts"], verificationCommands: ["pnpm test"], maxFilesTouched: 20 },
  }, "Implement the in/out button.\n");
  const state = await engine.store.readState();
  await engine.store.writeState({ ...state.data, phase: "plan_ready", activeSpecId: "spec-checkin", lastReadiness: "PASS" }, state.body);
  await mkdir(join(dir, ".legion-cli/plans"), { recursive: true });
  await writeFile(join(dir, ".legion-cli/plans/spec-checkin.md"), "# Reviewed plan\n\nImplement the approved task.\n");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/main.ts"), "export const value = 1;\n");
  const draft = join(dir, "assurance-draft.json");
  await writeFile(draft, JSON.stringify({
    schemaVersion: "legion-cli-assurance-plan/v1", specId: "spec-checkin", acceptanceIds: ["AC-01"], taskIds: ["TSK-0001"],
    security: {
      mode: "adapter-default", sources: [{ id: "main", path: "src/main.ts", classification: "workspace" }],
      sinks: [], transformations: [], tasks: [{ taskId: "TSK-0001", readPaths: ["src/main.ts"], transformationIds: [] }], externalCalls: [],
    },
    knowledge: [], validators: [], delivery: { artifacts: [] },
  }));
  return draft;
}

async function dashboardState(dir) {
  const { child, url } = startDashboardCli(["dashboard", "--project", dir, "--no-open", "--port", "0"]);
  try {
    const viewer = await url;
    const state = await fetch(`${viewer}/api/state`);
    assert.equal(state.status, 200);
    const page = await fetch(viewer);
    assert.equal(page.status, 200);
    return { snapshot: await state.json(), html: await page.text() };
  } finally {
    await stop(child);
  }
}

test("dashboard projects adopted assurance like status --json and renders the Assurance section", async () => {
  await withTempDir(async (dir) => {
    const draft = await seedAssuranceReady(dir);
    const approved = runCli(["plan", "approve", "--assurance", draft, "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(approved.status, 0, approved.stderr);
    const status = JSON.parse(runCli(["status", "--project", dir, "--json"]).stdout);
    assert.equal(status.assurance.mode, "adapter-default");

    const { snapshot, html } = await dashboardState(dir);
    assert.equal(snapshot.workflowError, null);
    assert.equal(snapshot.workflow.assurance.mode, "adapter-default");
    assert.equal(snapshot.workflow.assurance.traceStatus, status.assurance.traceStatus);
    assert.equal(snapshot.workflow.assurance.policyStatus, status.assurance.policyStatus);
    assert.equal(snapshot.workflow.assurance.informationFlow, "not-enforced");
    assert.deepEqual(snapshot.workflow.assurance.coverage, status.assurance.coverage);
    // The CLI appends its project selector to the engine's next command; the dashboard shows the engine's.
    assert.equal(status.next.run.replace(/ --project .*$/, ""), snapshot.workflow.next);
    assert.match(html, /<h2 id="assurance">Assurance<\/h2>/);
    assert.match(html, /mode: <strong>adapter-default<\/strong>/);
    assert.match(html, /information-flow: not enforced/);
    assert.match(html, new RegExp(`Trace: <strong>${status.assurance.traceStatus}</strong>`));
    assert.match(html, /Coverage: 0 covered · 0 failed · 1 unknown/);
  });
});

test("dashboard reports null assurance for a legacy plan approval", async () => {
  await withTempDir(async (dir) => {
    await seedAssuranceReady(dir);
    const approved = runCli(["plan", "approve", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(approved.status, 0, approved.stderr);
    const { snapshot, html } = await dashboardState(dir);
    assert.equal(snapshot.workflowError, null);
    assert.notEqual(snapshot.workflow, null);
    assert.equal(snapshot.workflow.assurance, null);
    assert.match(html, /Assurance not adopted\./);
  });
});
