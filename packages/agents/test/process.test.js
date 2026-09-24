import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
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
      '[System.IO.File]::WriteAllText((Join-Path (Get-Location) "ps1-ran.txt"), "ok`n")\n',
      "utf8",
    );
    const { job } = await setupRun(dir);
    const adapter = new GenericAdapter({ binary: script, args: ["{{pointer}}"] });
    const handle = await adapter.spawn(job);
    const result = await handle.wait();
    assert.equal(result.exitCode, 0, await readFile(result.stderrPath, "utf8"));
    assert.equal(await readFile(join(dir, "ps1-ran.txt"), "utf8"), "ok\n");
  });
});

test("Windows .cmd/.ps1 process-group abort kills descendants (taskkill /PID /T)", { skip: process.platform !== "win32" }, async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "sleep-tree.ps1");
    await writeFile(
      script,
      [
        `$exe = ${JSON.stringify(process.execPath)}`,
        "$psi = New-Object System.Diagnostics.ProcessStartInfo",
        "$psi.FileName = $exe",
        "$psi.Arguments = '-e setInterval(()=>{},1000)'",
        "$psi.UseShellExecute = $false",
        "$psi.CreateNoWindow = $true",
        "$p = [Diagnostics.Process]::Start($psi)",
        "[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'child-pid.txt'), [string]$p.Id)",
        "while ($true) { Start-Sleep -Seconds 60 }",
        "",
      ].join("\n"),
      "utf8",
    );
    const { job } = await setupRun(dir, { timeoutMs: 20_000 });
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
      8000,
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

test("suite reports 14 package legs, no-bail runner, quarantine register, and publish guard", async () => {
  const root = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const agentsMd = await readFile(join(repoRoot, "AGENTS.md"), "utf8");
  const ci = await readFile(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

  assert.equal(root.scripts.test, "pnpm -r --no-bail run test");
  assert.doesNotMatch(root.scripts.test, /--filter/);
  const packageDirs = await readdir(join(repoRoot, "packages"));
  const legs = [];
  for (const name of packageDirs) {
    try {
      const pkg = JSON.parse(await readFile(join(repoRoot, "packages", name, "package.json"), "utf8"));
      if (pkg.scripts?.test) legs.push(pkg.name);
    } catch {
      // not a package
    }
  }
  assert.equal(legs.length, EXPECTED_PACKAGE_LEGS);

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
  assert.equal(root.legionPublishAllowlist.includes("@9thlevelsoftware/legion-cli-http"), false);
  assert.match(agentsMd, /legionPublishAllowlist/);
  assert.match(agentsMd, /"private": true/);

  assert.match(ci, /linux-docker/);
  assert.match(ci, /Q-WIN-DOCKER/);
  assert.match(ci, /macos-latest/);
  assert.match(ci, /continue-on-error:\s*true/);
});
