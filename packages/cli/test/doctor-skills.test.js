import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { normalize, runCli, withTempDir } from "./helpers.js";

const REQUIRED_SKILL_IDS = ["plan", "execute", "review"];
const ALL_SKILL_IDS = [
  "interview",
  "discuss",
  "spec",
  "ingest",
  "plan",
  "execute",
  "verify",
  "review",
  "qa",
];

function skillMarkdown(skillId, overrides = {}) {
  const required = REQUIRED_SKILL_IDS.includes(skillId);
  const name = overrides.name ?? skillId;
  const description =
    overrides.description ??
    `Used when the engine runs ${skillId}. Activated only by \`legion-cli ${skillId}\`.`;
  const requiredVal = overrides.required ?? required;
  const skillIdField = overrides.skillId ?? skillId;
  const body = overrides.body ?? `# ${skillId}\n`;
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "license: UNLICENSED",
    'compatibility: "Legion CLI staging; not vendor auto-discovery"',
    "metadata:",
    "  legion:",
    `    skillId: ${skillIdField}`,
    `    required: ${requiredVal}`,
    `    allowedRootsRef: SKILL_CONTRACTS.${skillId}`,
    "---",
    "",
    body,
  ].join("\n");
}

async function writeSkillTree(skillsDir, opts = {}) {
  for (const skillId of ALL_SKILL_IDS) {
    if (skillId === opts.missingId) continue;
    const dir = join(skillsDir, skillId);
    await mkdir(dir, { recursive: true });
    const overrides = { body: opts.bodyFor?.[skillId] };
    if (skillId === opts.invalidId) overrides.name = `not-${skillId}`;
    if (opts.raw?.[skillId] !== undefined) {
      await writeFile(join(dir, "SKILL.md"), opts.raw[skillId], "utf8");
      continue;
    }
    await writeFile(join(dir, "SKILL.md"), skillMarkdown(skillId, overrides), "utf8");
  }
}

function doctorEnv(skillsDir) {
  return {
    LEGION_CLI_ADAPTER: "fake",
    LEGION_CLI_SKILLS_DIR: skillsDir,
  };
}

for (const skillId of REQUIRED_SKILL_IDS) {
  test(`doctor fails closed on invalid ${skillId} frontmatter (other required stay ok)`, async () => {
    await withTempDir(async (dir) => {
      runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
      const skillsDir = join(dir, "skills");
      await writeSkillTree(skillsDir, { invalidId: skillId });
      const result = runCli(["doctor", "--project", dir], { env: doctorEnv(skillsDir) });
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      const out = normalize(result.stdout);
      assert.match(out, new RegExp(`FAIL  skill ${skillId} frontmatter`));
      for (const other of REQUIRED_SKILL_IDS.filter((id) => id !== skillId)) {
        assert.match(out, new RegExp(`ok    skill ${other} frontmatter \\(ok\\)`));
      }
      assert.match(out, /Doctor failed/);
    });
  });
}

test("doctor warns on invalid optional skill and still passes", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const skillsDir = join(dir, "skills");
    await writeSkillTree(skillsDir, { raw: { qa: "# qa\nno frontmatter\n" } });
    const result = runCli(["doctor", "--project", dir], { env: doctorEnv(skillsDir) });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /optional skill skills\/qa\/SKILL.md: missing YAML frontmatter/);
    assert.match(out, /Doctor passed/);
    for (const skillId of REQUIRED_SKILL_IDS) {
      assert.match(out, new RegExp(`ok    skill ${skillId} frontmatter \\(ok\\)`));
    }
  });
});

test("doctor warns when SKILL.md body exceeds 20k and does not refuse", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const skillsDir = join(dir, "skills");
    const body = `# execute\n${"x".repeat(20_001)}\n`;
    await writeSkillTree(skillsDir, { bodyFor: { execute: body } });
    const result = runCli(["doctor", "--project", dir], { env: doctorEnv(skillsDir) });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /skills\/execute\/SKILL.md body is \d+ characters \(warn at 20000\)/);
    assert.match(out, /ok    skill execute frontmatter \(ok\)/);
    assert.match(out, /Doctor passed/);
  });
});
