import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { appendAuditEvent, ownProcessStartedAt } from "@9thlevelsoftware/legion-cli-persist";
import { allowCopyJailIn, normalize, runCli, withTempDir } from "./helpers.js";

const repoSkills = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
const env = { LEGION_CLI_ADAPTER: "fake", LEGION_CLI_SKILLS_DIR: repoSkills };

async function writeMarker(dir, runId, overrides) {
  const markerDir = join(dir, ".legion-cli", "cache", "live-spawn");
  await mkdir(markerDir, { recursive: true });
  const path = join(markerDir, `${runId}.json`);
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: "legion-cli-live-run/v1",
      runId,
      skillId: "execute",
      taskId: "TSK-0001",
      agentPid: null,
      startedAt: new Date().toISOString(),
      ...overrides,
    }),
    "utf8",
  );
  return path;
}

test("doctor clears a provably dead run marker and says what to do next", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    const path = await writeMarker(dir, "execute-dead", { enginePid: 2_000_000_000 });
    const result = runCli(["doctor", "--project", dir], { env });
    const out = normalize(result.stdout);
    assert.match(out, /Cleared {5}dead run marker execute-dead/, `${out}\n${result.stderr}`);
    assert.match(out, /restored by the next legion command/);
    assert.equal(existsSync(path), false);
  });
});

test("doctor reports a live run without touching it, and another verb is refused", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    // This test process is the live "engine": alive, and its identity matches the record.
    const path = await writeMarker(dir, "execute-live", {
      enginePid: process.pid,
      engineStartedAt: ownProcessStartedAt(),
    });
    const doctor = runCli(["doctor", "--project", dir], { env });
    assert.match(normalize(doctor.stdout), /Live run {4}execute execute-live \(TSK-0001\)/);
    assert.equal(existsSync(path), true);
    const refused = runCli(["control-mode", "advisory", "--project", dir]);
    assert.notEqual(refused.status, 0);
    assert.match(normalize(`${refused.stdout}${refused.stderr}`), /execute run execute-live is live/);
    const shown = runCli(["control-mode", "--project", dir]);
    assert.equal(shown.status, 0, `${shown.stdout}${shown.stderr}`);
  });
});

test("doctor and status report an edited middle audit line", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    for (let i = 0; i < 4; i++) {
      await appendAuditEvent(dir, {
        ts: `2026-01-01T00:00:0${i}.000Z`,
        type: "note",
        phase: "initialized",
        actor: "user",
        data: { marker: `line-${i}` },
      });
    }
    const jsonl = join(dir, ".legion-cli", "audit", "events.jsonl");
    const healthy = runCli(["doctor", "--project", dir], { env });
    assert.match(normalize(healthy.stdout), /audit chain/);
    assert.equal(healthy.status, 0);
    assert.match(normalize(healthy.stdout), /ok {4}audit chain/);
    const lines = (await readFile(jsonl, "utf8")).split(/\r?\n/);
    const at = lines.findIndex((line) => line.includes("line-1"));
    lines[at] = lines[at].replace("line-1", "line-X");
    await writeFile(jsonl, lines.join("\n"), "utf8");
    const doctor = runCli(["doctor", "--project", dir], { env });
    assert.notEqual(doctor.status, 0);
    assert.match(normalize(doctor.stdout), /FAIL {2}audit chain/);
    const status = runCli(["status", "--project", dir, "--plain"], { env });
    assert.match(normalize(status.stdout), /blocker\taudit chain/);
  });
});

async function seedAuditLog(dir) {
  for (let i = 0; i < 4; i++) {
    await appendAuditEvent(dir, {
      ts: `2026-01-01T00:00:0${i}.000Z`,
      type: "note",
      phase: "initialized",
      actor: "user",
      data: { marker: `line-${i}` },
    });
  }
}

test("doctor --rebaseline-audit is the recorded way out of a corrupt or deleted chain.json", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await allowCopyJailIn(dir);
    await seedAuditLog(dir);
    const chain = join(dir, ".legion-cli", "audit", "chain.json");
    await writeFile(chain, "{not json", "utf8");
    const broken = runCli(["doctor", "--project", dir], { env });
    assert.notEqual(broken.status, 0);
    assert.match(normalize(broken.stdout), /FAIL {2}audit chain/);
    assert.match(normalize(broken.stdout), /rebaseline-audit/);
    const status = runCli(["status", "--project", dir, "--plain"], { env });
    assert.match(normalize(status.stdout), /blocker	audit chain/);
    const fixed = runCli(["doctor", "--rebaseline-audit", "--project", dir], { env });
    assert.match(normalize(fixed.stdout), /re-baselined/);
    assert.equal(fixed.status, 0);
    const again = runCli(["doctor", "--project", dir], { env });
    assert.equal(again.status, 0);
    const log = await readFile(join(dir, ".legion-cli", "audit", "events.jsonl"), "utf8");
    assert.match(log, /"type":"audit_rebaselined"/);
    await rm(chain);
    const deleted = runCli(["doctor", "--project", dir], { env });
    assert.notEqual(deleted.status, 0, "a deleted chain over a multi-line log is not silently re-chained");
  });
});
