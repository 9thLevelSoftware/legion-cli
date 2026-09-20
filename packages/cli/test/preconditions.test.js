import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { appendAuditEvent, controlProjectDirPath, quarantineRootPath } from "@9thlevelsoftware/legion-cli-persist";

import {
  allowCopyJailIn,
  normalize,
  runCli,
  spawnSleeper,
  withTempDir,
  writeLiveControlRecords,
} from "./helpers.js";

test("KD-3: init outside a git repo prints the git next step; doctor reports the missing repository", async () => {
  await withTempDir(
    async (dir) => {
      const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
      assert.equal(init.status, 0, init.stderr);
      assert.match(normalize(init.stderr), /git repository with at least one commit/);
      assert.match(normalize(init.stderr), /git init && git add -A && git commit -m "start"/);
      await allowCopyJailIn(dir);
      const doctor = runCli(["doctor", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
      assert.notEqual(doctor.status, 0);
      assert.match(normalize(doctor.stdout), /FAIL {2}git repository \(not a git repository; next: git init/);
    },
    { git: false },
  );
});

test("R-40: doctor lists retained quarantines and flags a manifest that does not match its audited hash", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const root = quarantineRootPath(dir);
    const intact = join(root, "review-aaaa-0123456789ab");
    const tampered = join(root, "review-bbbb-0123456789ab");
    const body = `${JSON.stringify({ runId: "review-aaaa", entries: [] })}\n`;
    for (const folder of [intact, tampered]) {
      await mkdir(join(folder, "files"), { recursive: true });
      await writeFile(join(folder, "MANIFEST.json"), body);
      await writeFile(join(folder, "files", "STATE.md"), "forged\n");
      await appendAuditEvent(dir, {
        ts: new Date().toISOString(),
        type: "quarantine_created",
        phase: "initialized",
        actor: "engine",
        data: { dir: folder, manifestSha256: createHash("sha256").update(body).digest("hex") },
      });
    }
    await writeFile(join(tampered, "MANIFEST.json"), `${JSON.stringify({ runId: "edited", entries: [] })}\n`);
    await allowCopyJailIn(dir);
    const doctor = runCli(["doctor", "--project", dir, "--json"], { env: { LEGION_CLI_ADAPTER: "fake" } });
    const report = JSON.parse(doctor.stdout);
    const byDir = Object.fromEntries(report.quarantine.map((entry) => [entry.dir, entry]));
    assert.equal(byDir[intact].integrity, "intact");
    assert.equal(byDir[intact].files, 2);
    assert.equal(byDir[tampered].integrity, "MANIFEST.json does not match the audited hash");
    assert.ok(report.warnings.some((warning) => warning.includes(tampered)));
    const text = runCli(["doctor", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.match(normalize(text.stdout), /Quarantine \(retained; never deleted by Legion\)/);
  });
});

// PR 5 R-42: plan item 10's "doctor reports the total retained control-dir size and the path".
test("doctor reports retained pre-spawn backups, and only the runs that kept them", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    await allowCopyJailIn(dir);
    const control = controlProjectDirPath(dir);
    // One run that kept backups, and one that did not (only a resume record).
    await mkdir(join(control, "execute-kept", "pre"), { recursive: true });
    await writeFile(join(control, "execute-kept", "pre", "0001.bin"), "abcde");
    await writeFile(join(control, "execute-kept", "tree-manifest.json"), "{}\n");
    await mkdir(join(control, "execute-clean"), { recursive: true });
    await writeFile(join(control, "execute-clean", "resume.json"), "{}\n");

    const report = JSON.parse(
      runCli(["doctor", "--project", dir, "--json"], { env: { LEGION_CLI_ADAPTER: "fake" } }).stdout,
    );
    void report;
    const text = normalize(
      runCli(["doctor", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } }).stdout,
    );
    assert.match(text, /Run control dir \(pre-spawn backups kept for incident runs and crash replay\)/);
    // Exactly one run, exactly the five bytes of the one backup: the resume-only run is excluded.
    assert.match(text, /^ {2}1 run\(s\), 1 file\(s\), 5 bytes {2}/m);
    assert.match(text, /including ignored ones such as \.env/);
  });
});

test("R-6/R-19: status and doctor name the agent run that is freezing writes", async (t) => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    await allowCopyJailIn(dir);
    const other = spawnSleeper();
    t.after(() => other.stop());
    const control = await writeLiveControlRecords(dir, "review-live", "review", other.pid);

    const status = runCli(["status", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.match(normalize(status.stdout), /Agent run {3}review review-live {2}live/);
    assert.match(normalize(status.stdout), new RegExp(`engine pid ${other.pid}`));
    assert.match(normalize(status.stdout), /engine writes are frozen/);
    const statusJson = JSON.parse(
      runCli(["status", "--project", dir, "--json"], { env: { LEGION_CLI_ADAPTER: "fake" } }).stdout,
    );
    assert.equal(statusJson.agentRun.runId, "review-live");
    assert.equal(statusJson.agentRun.state, "live");
    assert.equal(statusJson.agentRun.controlDir, control);

    const doctor = runCli(["doctor", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.match(normalize(doctor.stdout), /Agent run\n {2}review review-live {2}live/);
    const doctorJson = JSON.parse(
      runCli(["doctor", "--project", dir, "--json"], { env: { LEGION_CLI_ADAPTER: "fake" } }).stdout,
    );
    assert.equal(doctorJson.agentRun.runId, "review-live");
    assert.ok(doctorJson.warnings.some((warning) => warning.includes("an agent run is in progress")));

    // A write from this second process is refused while that run holds the freeze.
    const ticket = runCli(["ticket", "create", "--project", dir, "--title", "park"], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.notEqual(ticket.status, 0);
    assert.match(normalize(ticket.stderr), /an agent run [(]review review-live[)] is in progress/);
  });
});

test("KD-3: init inside a repo with a commit prints no git hint", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    assert.doesNotMatch(normalize(init.stderr), /git repository/);
  });
});
