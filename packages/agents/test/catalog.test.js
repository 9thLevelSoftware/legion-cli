import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  REQUIRED_SKILL_IDS,
  SKILL_BODY_WARN_CHARS,
  findSkillsDir,
  listLevel3Resources,
  listSkillCatalog,
  parseSkillFrontmatter,
  renderSkillCatalog,
} from "../dist/index.js";
import { withTempDir } from "./helpers.js";

const repoSkills = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

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

async function writeSkillTree(skillsDir, opts = {}) {
  const invalidId = opts.invalidId;
  const missingId = opts.missingId;
  const bodyFor = opts.bodyFor ?? {};
  for (const skillId of ALL_SKILL_IDS) {
    if (skillId === missingId) continue;
    const dir = join(skillsDir, skillId);
    await mkdir(dir, { recursive: true });
    const overrides = {
      body: bodyFor[skillId],
    };
    if (skillId === invalidId) {
      overrides.name = `not-${skillId}`;
    }
    if (opts.raw?.[skillId] !== undefined) {
      await writeFile(join(dir, "SKILL.md"), opts.raw[skillId], "utf8");
      continue;
    }
    await writeFile(join(dir, skillId === invalidId ? "SKILL.md" : "SKILL.md"), skillMarkdown(skillId, overrides), "utf8");
  }
}

test("parseSkillFrontmatter accepts valid execute frontmatter", () => {
  const parsed = parseSkillFrontmatter(skillMarkdown("execute"), "skills/execute/SKILL.md");
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  assert.equal(parsed.entry.skillId, "execute");
  assert.equal(parsed.entry.name, "execute");
  assert.equal(parsed.entry.required, true);
  assert.equal(parsed.entry.path, "skills/execute/SKILL.md");
  assert.match(parsed.entry.description, /Activated only by/);
});

test("parseSkillFrontmatter fails when name does not equal directory and skillId", () => {
  const parsed = parseSkillFrontmatter(
    skillMarkdown("execute", { name: "not-execute" }),
    "skills/execute/SKILL.md",
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /must equal directory "execute" and skillId "execute"/);
});

test("parseSkillFrontmatter fails when description exceeds 400 characters", () => {
  const parsed = parseSkillFrontmatter(
    skillMarkdown("qa", { description: `Activated only by legion-cli qa. ${"x".repeat(400)}` }),
    "skills/qa/SKILL.md",
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /description exceeds 400 characters/);
});

test("parseSkillFrontmatter fails without frontmatter", () => {
  const parsed = parseSkillFrontmatter("# execute\n", "skills/execute/SKILL.md");
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /missing YAML frontmatter/);
});

test("listSkillCatalog never throws on optional-skill parse failure", async () => {
  await withTempDir(async (dir) => {
    const skillsDir = join(dir, "skills");
    await writeSkillTree(skillsDir, {
      raw: { qa: "---\n:::: not yaml\n---\n# qa\n" },
    });
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

test("listSkillCatalog keeps valid entries when a required skill is invalid", async () => {
  await withTempDir(async (dir) => {
    const skillsDir = join(dir, "skills");
    await writeSkillTree(skillsDir, { invalidId: "plan" });
    const result = listSkillCatalog(skillsDir);
    assert.ok(result.skipped.some((row) => row.path === "skills/plan/SKILL.md" && row.required === true));
    assert.ok(result.catalog.skills.some((skill) => skill.skillId === "execute"));
    assert.ok(result.catalog.skills.some((skill) => skill.skillId === "review"));
    assert.equal(
      result.catalog.skills.some((skill) => skill.skillId === "plan"),
      false,
    );
  });
});

test("listSkillCatalog records missing required SKILL.md as skipped required", async () => {
  await withTempDir(async (dir) => {
    const skillsDir = join(dir, "skills");
    await writeSkillTree(skillsDir, { missingId: "review" });
    const result = listSkillCatalog(skillsDir);
    assert.ok(result.skipped.some((row) => row.path === "skills/review/SKILL.md" && row.required === true));
    assert.ok(result.catalog.skills.some((skill) => skill.skillId === "plan"));
  });
});

test("listSkillCatalog of the repo skills tree has nine valid entries", () => {
  const { catalog, skipped } = listSkillCatalog(repoSkills);
  assert.deepEqual(
    skipped.filter((row) => row.required),
    [],
  );
  assert.equal(catalog.skills.length, 9);
  for (const skill of catalog.skills) {
    assert.deepEqual(skill.resources, { scripts: [], references: [], assets: [] }, skill.skillId);
    assert.deepEqual(listLevel3Resources(join(repoSkills, skill.skillId)), {
      scripts: [],
      references: [],
      assets: [],
    });
  }
  for (const skillId of REQUIRED_SKILL_IDS) {
    const entry = catalog.skills.find((skill) => skill.skillId === skillId);
    assert.ok(entry, `missing required ${skillId}`);
    assert.equal(entry.required, true);
    assert.equal(entry.name, skillId);
    assert.ok(entry.bodyChars <= SKILL_BODY_WARN_CHARS, `${skillId} body ${entry.bodyChars}`);
  }
});

test("renderSkillCatalog marks the active skill", () => {
  const rendered = renderSkillCatalog(
    {
      schemaVersion: "legion-cli-skill-catalog/v1",
      skills: [
        {
          skillId: "execute",
          name: "execute",
          description: "Write product code.",
          required: true,
          resources: { scripts: [], references: [], assets: [] },
          bodyChars: 1,
          path: "skills/execute/SKILL.md",
        },
        {
          skillId: "review",
          name: "review",
          description: "Spec-level review.",
          required: true,
          resources: { scripts: [], references: [], assets: [] },
          bodyChars: 1,
          path: "skills/review/SKILL.md",
        },
      ],
    },
    { activeSkillId: "execute" },
  );
  assert.match(rendered, /# Skills \(Level 1 catalog\)/);
  assert.match(rendered, /- execute \(active\): Write product code\./);
  assert.match(rendered, /- review: Spec-level review\./);
  assert.match(rendered, /Do not load other skill bodies/);
});

test("listLevel3Resources lists relative POSIX paths and ignores missing dirs", async () => {
  await withTempDir(async (dir) => {
    const skillDir = join(dir, "skills", "execute");
    await mkdir(join(skillDir, "references", "nested"), { recursive: true });
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await writeFile(join(skillDir, "references", "foo.md"), "# foo\n", "utf8");
    await writeFile(join(skillDir, "references", "nested", "bar.md"), "# bar\n", "utf8");
    await writeFile(join(skillDir, "scripts", "run.sh"), "#!/bin/sh\n", "utf8");
    const listed = listLevel3Resources(skillDir);
    assert.deepEqual(listed.scripts, ["scripts/run.sh"]);
    assert.deepEqual(listed.references, ["references/foo.md", "references/nested/bar.md"]);
    assert.deepEqual(listed.assets, []);
  });
});

test("findSkillsDir honors LEGION_CLI_SKILLS_DIR and does not depend on PATH", async () => {
  await withTempDir(async (dir) => {
    const skillsDir = join(dir, "skills");
    await mkdir(join(skillsDir, "plan"), { recursive: true });
    await writeFile(join(skillsDir, "plan", "SKILL.md"), skillMarkdown("plan"), "utf8");
    const previous = process.env.LEGION_CLI_SKILLS_DIR;
    process.env.LEGION_CLI_SKILLS_DIR = skillsDir;
    try {
      assert.equal(findSkillsDir("/does/not/exist"), skillsDir);
    } finally {
      if (previous === undefined) delete process.env.LEGION_CLI_SKILLS_DIR;
      else process.env.LEGION_CLI_SKILLS_DIR = previous;
    }
    assert.equal(findSkillsDir(dir), skillsDir);
  });
});
