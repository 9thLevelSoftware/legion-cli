import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { appendAuditEvent, quarantineRootPath } from "@9thlevelsoftware/legion-cli-persist";

import { allowCopyJailIn, normalize, runCli, withTempDir } from "./helpers.js";

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

test("KD-3: init inside a repo with a commit prints no git hint", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    assert.doesNotMatch(normalize(init.stderr), /git repository/);
  });
});
