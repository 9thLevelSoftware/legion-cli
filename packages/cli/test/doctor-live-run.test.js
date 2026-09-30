import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ownProcessStartedAt } from "@9thlevelsoftware/legion-cli-persist";
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
