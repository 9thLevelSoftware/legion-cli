import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DOCKER_HOST_EXEC_REFUSAL, DOCKER_WORKDIR } from "@9thlevelsoftware/legion-cli-sandbox";
import { GenericAdapter } from "../dist/index.js";
import { pkgRoot, setupRun, withTempDir } from "./helpers.js";

const repoRoot = join(pkgRoot, "..", "..");
const EXPECTED_PACKAGE_LEGS = 14;
const EXPECTED_QUARANTINE_COUNT = 5;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

async function waitUntil(predicate, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

test("wrapper-extension branch matches .cmd .bat and .ps1", async () => {
  const src = await readFile(join(pkgRoot, "src", "process.ts"), "utf8");
  assert.match(src, /\/\\\.\(cmd\|bat\|ps1\)\$\/i/);
});

test("Windows .ps1 spawn runs through the wrapper-extension branch", { skip: process.platform !== "win32" }, async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "echo-ran.ps1");
    await writeFile(
      script,
      "Set-Content -LiteralPath (Join-Path (Get-Location) 'ps1-ran.txt') -Value \"ok\" -NoNewline\n",
      "utf8",
    );
    const { job } = await setupRun(dir, { timeoutMs: 60_000 });
    const adapter = new GenericAdapter({ binary: script, args: ["{{pointer}}"] });
    const handle = await adapter.spawn(job);
    const result = await handle.wait();
    const stderr = await readFile(result.stderrPath, "utf8");
    const stdout = await readFile(result.stdoutPath, "utf8");
    assert.equal(result.exitCode, 0, `stderr=${stderr}\nstdout=${stdout}\ntimedOut=${result.timedOut}`);
    assert.match(await readFile(join(dir, "ps1-ran.txt"), "utf8"), /^ok\r?\n?$/);
  });
});

test("docker wrapper invoke is translated by sandbox translateWrapperInvoke", async () => {
  await withTempDir(async (dir) => {
    const recorder = join(dir, "record-argv.js");
    await writeFile(
      recorder,
      'require("fs").writeFileSync(require("path").join(process.cwd(), "wrapper-argv.json"), JSON.stringify(process.argv.slice(2)));\n',
      "utf8",
    );
    const { job } = await setupRun(dir);
    job.wrapper = {
      bin: process.execPath,
      argvPrefix: [recorder, "-w", DOCKER_WORKDIR, "node:22-alpine"],
    };
    const adapter = new GenericAdapter({ binary: process.execPath, args: ["{{pointer}}"] });
    const handle = await adapter.spawn(job);
    const result = await handle.wait();
    assert.equal(result.exitCode, 0, await readFile(result.stderrPath, "utf8"));
    const argv = JSON.parse(await readFile(join(dir, "wrapper-argv.json"), "utf8"));
    assert.equal(argv.includes("node"), true);
    assert.equal(
      argv.some((arg) => String(arg).startsWith(`${DOCKER_WORKDIR}/`)),
      false,
    );

    const outside = await mkdtemp(join(tmpdir(), "legion-hostbin-"));
    try {
      const hostClaude = join(outside, "claude.exe");
      await writeFile(hostClaude, "", "utf8");
      const refused = await setupRun(dir, { runId: "run-claude" });
      refused.job.wrapper = { bin: process.execPath, argvPrefix: ["-w", DOCKER_WORKDIR] };
      const claude = new GenericAdapter({ binary: hostClaude, args: ["{{pointer}}"] });
      await assert.rejects(() => claude.spawn(refused.job), (err) => {
        assert.equal(err.message, DOCKER_HOST_EXEC_REFUSAL);
        return true;
      });
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

test("Windows .cmd/.ps1 process-group abort kills descendants (taskkill /PID /T)", { skip: process.platform !== "win32" }, async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "sleep-tree.ps1");
    await writeFile(
      join(dir, "child.js"),
      "require('node:fs').writeFileSync('child-pid.txt', String(process.pid)); setInterval(() => {}, 1000);\n",
      "utf8",
    );
    await writeFile(
      script,
      ["param($pointer)", `$exe = ${JSON.stringify(process.execPath)}`, "& $exe child.js", ""].join("\n"),
      "utf8",
    );
    const { job } = await setupRun(dir, { timeoutMs: 60_000 });
    const adapter = new GenericAdapter({ binary: script, args: ["{{pointer}}"] });
    const handle = await adapter.spawn(job);
    const childPidPath = join(dir, "child-pid.txt");
    await waitUntil(
      async () => {
        try {
          await readFile(childPidPath, "utf8");
          return true;
        } catch {
          return false;
        }
      },
      20000,
      "descendant pid file was not written",
    );
    const childPid = Number((await readFile(childPidPath, "utf8")).trim());
    try {
      assert.ok(Number.isInteger(childPid) && childPid > 0);
      assert.equal(pidAlive(handle.pid), true);
      assert.equal(pidAlive(childPid), true);
      const waiting = handle.wait();
      await handle.abort();
      await waiting;
      await waitUntil(
        () => !pidAlive(handle.pid) && !pidAlive(childPid),
        5000,
        "surviving-descendant: process group still alive after abort",
      );
    } finally {
      if (Number.isInteger(childPid) && childPid > 0) {
        spawnSync("taskkill", ["/PID", String(childPid), "/T", "/F"], { windowsHide: true, shell: false });
      }
    }
  });
});

function yamlJob(ci, name) {
  const start = ci.search(new RegExp(`^  ${name}:`, "m"));
  assert.ok(start >= 0, `missing job ${name}`);
  const from = ci.indexOf("\n", start) + 1;
  const rest = ci.slice(from);
  const next = rest.search(/\n  [A-Za-z#]/);
  return next === -1 ? rest : rest.slice(0, next);
}

test("recursive runner inventory is 14 package legs", async () => {
  const workspace = await readFile(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /^\s*-\s+"packages\/\*"/m);
  const pnpmArgs = ["list", "-r", "--depth", "-1", "--json"];
  const listing = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...pnpmArgs], {
        cwd: repoRoot,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      })
    : spawnSync("pnpm", pnpmArgs, {
        cwd: repoRoot,
        encoding: "utf8",
        shell: true,
        windowsHide: true,
      });
  assert.equal(listing.status, 0, listing.stderr || listing.error?.message);
  const listed = JSON.parse(listing.stdout);
  const workspacePkgs = listed.filter((entry) => entry.name !== "product-engineer-helper");
  assert.equal(workspacePkgs.length, EXPECTED_PACKAGE_LEGS);
  const legs = [];
  for (const entry of workspacePkgs) {
    const pkg = JSON.parse(await readFile(join(entry.path, "package.json"), "utf8"));
    assert.ok(pkg.scripts?.test, `${pkg.name} missing test script`);
    legs.push(pkg.name);
  }
  assert.equal(legs.length, EXPECTED_PACKAGE_LEGS);
});

test("root test script, quarantine register, and publish guard", async () => {
  const root = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const agentsMd = await readFile(join(repoRoot, "AGENTS.md"), "utf8");
  assert.equal(root.scripts.test, "pnpm -r --no-bail run test");
  assert.doesNotMatch(root.scripts.test, /--filter/);
  assert.ok(Array.isArray(root.legionQuarantine));
  assert.equal(root.legionQuarantine.length, EXPECTED_QUARANTINE_COUNT);
  for (const entry of root.legionQuarantine) {
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.id.length > 0);
    assert.equal(typeof entry.name, "string");
    assert.ok(entry.name.length > 0);
    assert.equal(typeof entry.owningPr, "number");
    assert.ok(entry.owningPr >= 1);
    assert.match(String(entry.failBy), /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(root.private, true);
  assert.ok(Array.isArray(root.legionPublishAllowlist));
  assert.ok(root.legionPublishAllowlist.length > 0);
  assert.equal(root.legionPublishAllowlist.includes("product-engineer-helper"), false);
  assert.equal(root.legionPublishAllowlist.includes("@9thlevelsoftware/legion-cli-http"), true);
  const httpPkg = JSON.parse(await readFile(join(repoRoot, "packages", "http", "package.json"), "utf8"));
  assert.notEqual(httpPkg.private, true);
  assert.equal(httpPkg.publishConfig?.access, "public");
  assert.match(agentsMd, /legionPublishAllowlist/);
  assert.match(agentsMd, /"private": true/);
});

test("CI linux-docker is required and macos is droppable", async () => {
  const ci = await readFile(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const linux = yamlJob(ci, "linux-docker");
  const macos = yamlJob(ci, "macos");
  assert.doesNotMatch(linux, /continue-on-error/);
  assert.match(macos, /continue-on-error:\s*true/);
  assert.match(linux, /docker info/);
  assert.match(linux, /detectSandbox/);
  assert.match(linux, /backend !== "docker"/);
  assert.match(ci, /Q-WIN-DOCKER/);
  assert.match(ci, /macos-latest/);
});
