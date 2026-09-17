import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { hashSkillTree } from "@9thlevelsoftware/legion-cli-agents";
import { LegionEngine, LegionRefuseError } from "../dist/index.js";
import {
  initProject,
  passingVerificationCommand,
  readLatestRunPrompt,
  seedPlanReady,
  withEngine,
  withFakeAdapter,
} from "./helpers.js";

const REQUIRED_SKILL_IDS = ["plan", "execute", "review"];

function skillMarkdown(skillId, overrides = {}) {
  const required = REQUIRED_SKILL_IDS.includes(skillId);
  const name = overrides.name ?? skillId;
  const description =
    overrides.description ?? `Used when the engine runs ${skillId}. Activated only by \`legion-cli ${skillId}\`.`;
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "license: UNLICENSED",
    'compatibility: "Legion CLI staging; not vendor auto-discovery"',
    "metadata:",
    "  legion:",
    `    skillId: ${overrides.skillId ?? skillId}`,
    `    required: ${overrides.required ?? required}`,
    `    allowedRootsRef: SKILL_CONTRACTS.${skillId}`,
    "---",
    "",
    overrides.body ?? `# ${skillId}\n`,
  ].join("\n");
}

async function writePackagedSkills(skillsDir) {
  for (const skillId of REQUIRED_SKILL_IDS) {
    await mkdir(join(skillsDir, skillId), { recursive: true });
    await writeFile(join(skillsDir, skillId, "SKILL.md"), skillMarkdown(skillId), "utf8");
  }
}

async function writePinnedOverlay(projectRoot, skillId, markdown) {
  const overlay = join(projectRoot, ".legion-cli", "skills", skillId);
  await mkdir(overlay, { recursive: true });
  await writeFile(join(overlay, "SKILL.md"), markdown, "utf8");
  const sha256 = await hashSkillTree(overlay);
  await writeFile(
    join(overlay, "overlay.json"),
    `${JSON.stringify({
      schemaVersion: "legion-cli-skill-overlay/v1",
      skillId,
      source: { type: "local", origin: overlay },
      integrity: { sha256 },
      installedAt: "2026-09-17T00:00:00Z",
    })}\n`,
    "utf8",
  );
  return overlay;
}

test("overlay execute SKILL.md description appears in the spawn prompt", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, {
        task: { contract: { verificationCommands: [passingVerificationCommand()] } },
      });
      const skillsDir = join(dir, "skills");
      await writePackagedSkills(skillsDir);
      await writePinnedOverlay(
        dir,
        "execute",
        skillMarkdown("execute", { description: "OVERLAY_EXECUTE_DESC_TOKEN" }),
      );
      const gated = new LegionEngine(dir, undefined, { skillsDir });
      await gated.execute("TSK-0001");
      const prompt = await readLatestRunPrompt(dir, "execute");
      assert.match(prompt, /OVERLAY_EXECUTE_DESC_TOKEN/);
    });
  });
});

test("bad frontmatter overlay on required skill refuses spawn", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, {
        task: { contract: { verificationCommands: [passingVerificationCommand()] } },
      });
      const skillsDir = join(dir, "skills");
      await writePackagedSkills(skillsDir);
      await writePinnedOverlay(dir, "execute", skillMarkdown("execute", { name: "not-execute" }));
      const gated = new LegionEngine(dir, undefined, { skillsDir });
      await assert.rejects(
        () => gated.execute("TSK-0001"),
        (err) => {
          assert.equal(err instanceof LegionRefuseError, true);
          assert.match(err.message, /frontmatter/);
          assert.match(err.message, /\.legion-cli\/skills\/execute\/SKILL\.md/);
          return true;
        },
      );
    });
  });
});

test("unpinned overlay SKILL.md without overlay.json is ignored", async () => {
  await withFakeAdapter(async () => {
    await withEngine(async ({ dir, engine, store }) => {
      await initProject(engine);
      await seedPlanReady(store, {
        task: { contract: { verificationCommands: [passingVerificationCommand()] } },
      });
      const skillsDir = join(dir, "skills");
      await writePackagedSkills(skillsDir);
      const overlay = join(dir, ".legion-cli", "skills", "execute");
      await mkdir(overlay, { recursive: true });
      await writeFile(
        join(overlay, "SKILL.md"),
        skillMarkdown("execute", { description: "OVERLAY_EXECUTE_DESC_TOKEN" }),
        "utf8",
      );
      const gated = new LegionEngine(dir, undefined, { skillsDir });
      await gated.execute("TSK-0001");
      const prompt = await readLatestRunPrompt(dir, "execute");
      assert.match(prompt, /Used when the engine runs execute/);
      assert.doesNotMatch(prompt, /OVERLAY_EXECUTE_DESC_TOKEN/);
    });
  });
});
