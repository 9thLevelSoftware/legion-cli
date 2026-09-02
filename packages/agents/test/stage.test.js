import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runCachePaths, stageSkill, writeRunPrompt } from "../dist/index.js";
import { withTempDir, writeSkill } from "./helpers.js";

test("stageSkill copies the skill tree and does not symlink", async () => {
  await withTempDir(async (dir) => {
    const skillDir = join(dir, "skills", "plan");
    await writeSkill(skillDir, "# plan skill\n");
    const dest = await stageSkill({ projectRoot: dir, runId: "run-copy", skillDir });
    const skillMd = join(dest, "SKILL.md");
    assert.equal(lstatSync(dest).isSymbolicLink(), false);
    assert.equal(lstatSync(skillMd).isSymbolicLink(), false);
    assert.equal(lstatSync(skillMd).isFile(), true);
    assert.equal(await readFile(skillMd, "utf8"), "# plan skill\n");
    await writeFile(join(skillDir, "SKILL.md"), "# mutated\n", "utf8");
    assert.equal(await readFile(skillMd, "utf8"), "# plan skill\n");
  });
});

test("stageSkill copies craft/*.md into the staged tree", async () => {
  await withTempDir(async (dir) => {
    const skillDir = join(dir, "skills", "execute");
    const craftDir = join(dir, "craft");
    await writeSkill(skillDir);
    await mkdir(craftDir, { recursive: true });
    await writeFile(join(craftDir, "rules.md"), "be careful\n", "utf8");
    await writeFile(join(craftDir, "notes.txt"), "skip me\n", "utf8");
    const dest = await stageSkill({
      projectRoot: dir,
      runId: "run-craft",
      skillDir,
      craftDir,
    });
    assert.equal(await readFile(join(dest, "craft", "rules.md"), "utf8"), "be careful\n");
    assert.equal(existsSync(join(dest, "craft", "notes.txt")), false);
  });
});

test("writeRunPrompt appends DESIGN.md when present", async () => {
  await withTempDir(async (dir) => {
    const designDir = join(dir, ".legion-cli", "design");
    await mkdir(designDir, { recursive: true });
    await writeFile(join(designDir, "DESIGN.md"), "Brand ink is #222.\n", "utf8");
    const promptPath = await writeRunPrompt({
      projectRoot: dir,
      runId: "run-design",
      body: "Follow the skill.\n",
    });
    const text = await readFile(promptPath, "utf8");
    assert.match(text, /Follow the skill/);
    assert.match(text, /## DESIGN\.md/);
    assert.match(text, /Brand ink is #222/);
    assert.equal(promptPath, runCachePaths(dir, "run-design").promptPath);
  });
});
