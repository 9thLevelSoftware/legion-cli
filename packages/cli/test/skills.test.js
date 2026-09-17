import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { overlaySkillDir } from "@9thlevelsoftware/legion-cli-agents";
import { normalize, runCli, withTempDir } from "./helpers.js";

const repoExecuteSkill = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills", "execute", "SKILL.md");

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
    overrides.body ?? `# ${skillId}\n`,
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
    const packagedBefore = await readFile(repoExecuteSkill, "utf8");
    const result = runCli(["skills", "install", src, "--unsigned", "--project", dir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(normalize(result.stdout), /Installed overlay execute/);
    const pin = JSON.parse(await readFile(join(overlaySkillDir(dir, "execute"), "overlay.json"), "utf8"));
    assert.equal(pin.skillId, "execute");
    assert.equal(pin.source.type, "local");
    assert.equal(await readFile(repoExecuteSkill, "utf8"), packagedBefore);
    assert.doesNotMatch(packagedBefore, /OVERLAY_EXECUTE_DESC_TOKEN/);
    const shown = runCli(["skills", "show", "execute", "--project", dir]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(normalize(shown.stdout), /source: overlay/);
    assert.match(normalize(shown.stdout), /OVERLAY_EXECUTE_DESC_TOKEN/);
    assert.match(normalize(shown.stdout), /matches-tree: yes/);
    assert.match(normalize(shown.stdout), /bodyChars: /);
  });
});

test("skills install --unsigned github: refuses before fetch", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["skills", "install", "github:acme/skills@v1", "--unsigned", "--project", dir]);
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /cannot use --unsigned/);
    assert.match(normalize(result.stderr), /Next: legion-cli skills install/);
  });
});

test("skills install --integrity mismatch refuses", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const src = join(dir, "execute");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), skillMarkdown("execute"), "utf8");
    const result = runCli([
      "skills",
      "install",
      src,
      "--unsigned",
      "--integrity",
      `sha256:${"a".repeat(64)}`,
      "--project",
      dir,
    ]);
    assert.equal(result.status, 1);
    assert.match(normalize(result.stderr), /integrity mismatch/);
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
    assert.doesNotMatch(out, /unreadable overlay\.json/);
  });
});

test("doctor overlay body warning uses overlay path", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const src = join(dir, "execute");
    await mkdir(src, { recursive: true });
    const body = `# execute\n${"x".repeat(20_001)}\n`;
    await writeFile(
      join(src, "SKILL.md"),
      skillMarkdown("execute", { description: "overlay execute long body", body }),
      "utf8",
    );
    const install = runCli(["skills", "install", src, "--unsigned", "--project", dir]);
    assert.equal(install.status, 0, install.stderr);
    const doctor = runCli(["doctor", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
    const out = normalize(doctor.stdout);
    assert.match(out, /\.legion-cli\/skills\/execute\/SKILL.md body is \d+ characters \(warn at 20000\)/);
    assert.doesNotMatch(out, /^ {2}skills\/execute\/SKILL.md body is /m);
  });
});

test("doctor overlay lines distinguish digest mismatch from unreadable pin", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const overlay = overlaySkillDir(dir, "execute");
    await mkdir(overlay, { recursive: true });
    await writeFile(join(overlay, "SKILL.md"), skillMarkdown("execute", { description: "tampered overlay" }), "utf8");
    await writeFile(
      join(overlay, "overlay.json"),
      `${JSON.stringify({
        schemaVersion: "legion-cli-skill-overlay/v1",
        skillId: "execute",
        source: { type: "local", origin: overlay },
        integrity: { sha256: "a".repeat(64) },
        installedAt: "2026-09-17T00:00:00Z",
      })}\n`,
      "utf8",
    );
    const mismatch = runCli(["doctor", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(mismatch.status, 1, `${mismatch.stdout}\n${mismatch.stderr}`);
    assert.match(normalize(mismatch.stdout), /pin a{64} tree [a-f0-9]{64}/);
    assert.doesNotMatch(normalize(mismatch.stdout), /unreadable overlay\.json/);

    await writeFile(join(overlay, "overlay.json"), "{not-json\n", "utf8");
    const unreadable = runCli(["doctor", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(unreadable.status, 1, `${unreadable.stdout}\n${unreadable.stderr}`);
    assert.match(normalize(unreadable.stdout), /unreadable overlay\.json/);
  });
});


