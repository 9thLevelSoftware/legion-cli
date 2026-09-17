import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { overlaySkillDir } from "@9thlevelsoftware/legion-cli-agents";
import { normalize, runCli, withTempDir } from "./helpers.js";

function skillMarkdown(skillId, overrides = {}) {
  const required = ["plan", "execute", "review"].includes(skillId);
  const description = overrides.description ?? `Used when the engine runs ${skillId}.`;
  return [
    "---",
    `name: ${overrides.name ?? skillId}`,
    `description: ${JSON.stringify(description)}`,
    "license: UNLICENSED",
    'compatibility: "Legion CLI staging; not vendor auto-discovery"',
    "metadata:",
    "  legion:",
    `    skillId: ${overrides.skillId ?? skillId}`,
    `    required: ${required}`,
    `    allowedRootsRef: SKILL_CONTRACTS.${skillId}`,
    "---",
    "",
    `# ${skillId}\n`,
  ].join("\n");
}

test("skills list and show report packaged execute", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const listed = runCli(["skills", "list", "--project", dir, "--json"]);
    assert.equal(listed.status, 0, listed.stderr);
    const payload = JSON.parse(listed.stdout);
    assert.ok(payload.skills.some((skill) => skill.skillId === "execute"));
    const shown = runCli(["skills", "show", "execute", "--project", dir]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(normalize(shown.stdout), /source: packaged/);
    assert.match(normalize(shown.stdout), /skillId: execute/);
  });
});

test("skills show refuses unknown skillId", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["skills", "show", "not-a-skill", "--project", dir]);
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /unknown skillId/);
    assert.match(normalize(result.stderr), /Next: legion-cli skills show <id>/);
  });
});

test("skills install local --unsigned writes overlay", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const src = join(dir, "execute");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), skillMarkdown("execute", { description: "OVERLAY_EXECUTE_DESC_TOKEN" }), "utf8");
    const result = runCli(["skills", "install", src, "--unsigned", "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(normalize(result.stdout), /Installed overlay execute/);
    const pin = JSON.parse(await readFile(join(overlaySkillDir(dir, "execute"), "overlay.json"), "utf8"));
    assert.equal(pin.skillId, "execute");
    assert.equal(pin.source.type, "local");
    const shown = runCli(["skills", "show", "execute", "--project", dir]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(normalize(shown.stdout), /source: overlay/);
    assert.match(normalize(shown.stdout), /OVERLAY_EXECUTE_DESC_TOKEN/);
  });
});

test("skills install github:evil.com/foo is refused by allowlist", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["skills", "install", "github:evil.com/foo", "--project", dir]);
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /allowlist/);
    assert.match(normalize(result.stderr), /Next: legion-cli skills install/);
  });
});

test("doctor prints overlay pin vs packaged", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const src = join(dir, "execute");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), skillMarkdown("execute", { description: "overlay execute for doctor" }), "utf8");
    const install = runCli(["skills", "install", src, "--unsigned", "--project", dir]);
    assert.equal(install.status, 0, install.stderr);
    const doctor = runCli(["doctor", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
    const out = normalize(doctor.stdout);
    assert.match(out, /Overlays \(pin vs packaged\)/);
    assert.match(out, /execute\s+pin [a-f0-9]{64}/);
    assert.match(out, /packaged [a-f0-9]{64}/);
  });
});


