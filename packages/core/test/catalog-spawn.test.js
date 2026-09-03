import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { listSkillCatalog } from "@9thlevelsoftware/legion-cli-agents";
import { findSkillsDir, LegionEngine, LegionRefuseError } from "../dist/index.js";
import {
  initProject,
  seedFrozenSpec,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
} from "./helpers.js";

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
    const overrides = {};
    if (skillId === opts.invalidId) overrides.name = `not-${skillId}`;
    if (opts.raw?.[skillId] !== undefined) {
      await writeFile(join(dir, "SKILL.md"), opts.raw[skillId], "utf8");
      continue;
    }
    await writeFile(join(dir, "SKILL.md"), skillMarkdown(skillId, overrides), "utf8");
  }
  return skillsDir;
}

function isRefuse(err, message, hint) {
  assert.equal(err instanceof LegionRefuseError, true, `expected LegionRefuseError, got ${err?.name}: ${err?.message}`);
  assert.match(err.message, message);
  assert.match(err.nextHint, hint);
  return true;
}

test("core re-exports findSkillsDir", () => {
  assert.equal(typeof findSkillsDir, "function");
});

for (const skillId of REQUIRED_SKILL_IDS) {
  test(`${skillId} refuses invalid required skill frontmatter without depending on PATH`, async () => {
    await withFakeAdapter(async () => {
      await withEngine(async ({ dir, engine, store }) => {
        await initProject(engine);
        const skillsDir = join(dir, "skills");
        await writeSkillTree(skillsDir, { invalidId: skillId });
        const gated = new LegionEngine(dir, undefined, { skillsDir });
        if (skillId === "plan") {
          await seedFrozenSpec(store);
          await assert.rejects(
            () => gated.plan(),
            (err) => isRefuse(err, /plan requires valid skills\/plan\/SKILL.md frontmatter/, /legion-cli plan/),
          );
        } else if (skillId === "execute") {
          await seedPlanReady(store);
          await assert.rejects(
            () => gated.execute("TSK-0001"),
            (err) =>
              isRefuse(err, /execute requires valid skills\/execute\/SKILL.md frontmatter/, /legion-cli next \/ legion-cli execute/),
          );
        } else {
          await seedPlanReady(store, { phase: "executing", task: { status: "done" } });
          await assert.rejects(
            () => gated.review(),
            (err) => isRefuse(err, /review requires valid skills\/review\/SKILL.md frontmatter/, /legion-cli review/),
          );
        }
      });
    });
  });
}

test("optional verify spawn returns spawned false on invalid frontmatter", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, { phase: "executing" });
      const skillsDir = join(dir, "skills");
      await writeSkillTree(skillsDir, { invalidId: "verify" });
      const gated = new LegionEngine(dir, undefined, { skillsDir });
      const result = await gated.verify();
      assert.equal(result.spawned, false);
    });
  });
});

test("engine.brief includes Level 1 catalog without an active skill", async () => {
  await withEngine(async ({ engine }) => {
    await initProject(engine);
    const brief = await engine.brief();
    assert.ok(brief.skills && brief.skills.length > 0);
    assert.ok(brief.skills.some((skill) => skill.skillId === "execute"));
    assert.ok(brief.skills.some((skill) => skill.skillId === "plan"));
    assert.equal(
      brief.skills.some((skill) => skill.active),
      false,
    );
  });
});

test("malformed optional qa SKILL.md does not throw from listSkillCatalog", async () => {
  await withEngine(async ({ dir }) => {
    const skillsDir = join(dir, "skills");
    await writeSkillTree(skillsDir, { raw: { qa: "---\n{{{{{\n---\n" } });
    const result = listSkillCatalog(skillsDir);
    assert.ok(result.skipped.some((row) => row.path === "skills/qa/SKILL.md" && row.required === false));
    assert.ok(result.catalog.skills.some((skill) => skill.skillId === "execute"));
    assert.ok(result.catalog.skills.some((skill) => skill.skillId === "plan"));
    assert.equal(
      result.catalog.skills.some((skill) => skill.skillId === "qa"),
      false,
    );
  });
});
