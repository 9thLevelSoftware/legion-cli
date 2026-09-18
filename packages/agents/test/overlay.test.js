import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { crc32 } from "node:zlib";

import { MinisignError, PathEscapeError, SsrfError } from "@9thlevelsoftware/legion-cli-persist";
import {
  AgentError,
  hashSkillTree,
  installSkillOverlay,
  listResolvedSkillCatalog,
  overlaySkillDir,
  resolveSkillDir,
} from "../dist/index.js";
import { withTempDir } from "./helpers.js";

const minisignFixture = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "persist", "test", "fixtures", "minisign");

function skillMarkdown(skillId, overrides = {}) {
  const required = ["plan", "execute", "review"].includes(skillId);
  const name = overrides.name ?? skillId;
  const description = overrides.description ?? `Used when the engine runs ${skillId}.`;
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

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localFull = Buffer.concat([local, name, data]);
    locals.push(localFull);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += localFull.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

test("local install without --unsigned refuses", async () => {
  await withTempDir(async (dir) => {
    const src = join(dir, "execute");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), skillMarkdown("execute"), "utf8");
    await assert.rejects(
      () => installSkillOverlay({ projectRoot: dir, source: src }),
      (err) => {
        assert.equal(err instanceof AgentError, true);
        assert.match(err.message, /--unsigned/);
        return true;
      },
    );
  });
});

test("unsigned local install writes overlay pin and does not need minisign", async () => {
  await withTempDir(async (dir) => {
    const src = join(dir, "execute");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), skillMarkdown("execute", { description: "Overlay execute body." }), "utf8");
    const installed = await installSkillOverlay({
      projectRoot: dir,
      source: src,
      unsigned: true,
    });
    assert.equal(installed.skillId, "execute");
    assert.equal(installed.pin.source.type, "local");
    assert.equal(installed.pin.integrity.minisign, undefined);
    const dest = overlaySkillDir(dir, "execute");
    assert.equal(await readFile(join(dest, "SKILL.md"), "utf8"), skillMarkdown("execute", { description: "Overlay execute body." }));
    const resolved = await resolveSkillDir({ projectRoot: dir, skillId: "execute", packagedSkillsDir: join(dir, "missing") });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.source, "overlay");
  });
});

test("unpinned missing overlay falls back to packaged", async () => {
  await withTempDir(async (dir) => {
    const packaged = join(dir, "skills");
    await mkdir(join(packaged, "execute"), { recursive: true });
    await writeFile(join(packaged, "execute", "SKILL.md"), skillMarkdown("execute"), "utf8");
    const resolved = await resolveSkillDir({
      projectRoot: dir,
      skillId: "execute",
      packagedSkillsDir: packaged,
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.source, "packaged");
    assert.equal(resolved.skillDir, join(packaged, "execute"));
  });
});

test("pinned overlay digest mismatch refuses without packaged fallback", async () => {
  await withTempDir(async (dir) => {
    const packaged = join(dir, "skills");
    await mkdir(join(packaged, "execute"), { recursive: true });
    await writeFile(join(packaged, "execute", "SKILL.md"), skillMarkdown("execute"), "utf8");
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
    const resolved = await resolveSkillDir({
      projectRoot: dir,
      skillId: "execute",
      packagedSkillsDir: packaged,
    });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.pinned, true);
    assert.match(resolved.reason, /digest mismatch/);
  });
});

test("github:evil.com/foo is refused by allowlist", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => installSkillOverlay({ projectRoot: dir, source: "github:evil.com/foo" }),
      (err) => {
        assert.equal(err instanceof SsrfError, true);
        assert.match(err.message, /allowlist/);
        return true;
      },
    );
  });
});

test("remote without signature refuses even with --unsigned", async () => {
  await withTempDir(async (dir) => {
    let fetched = false;
    await assert.rejects(
      () =>
        installSkillOverlay({
          projectRoot: dir,
          source: "github:acme/skills@v1",
          unsigned: true,
          fetchZip: async () => {
            fetched = true;
            return { body: Buffer.from("nope") };
          },
        }),
      (err) => {
        assert.equal(err instanceof AgentError, true);
        assert.match(err.message, /cannot use --unsigned/);
        return true;
      },
    );
    assert.equal(fetched, false);
  });
});

test("remote without signature refuses", async () => {
  await withTempDir(async (dir) => {
    const zip = makeZip([
      { name: "skills-v1/execute/SKILL.md", data: skillMarkdown("execute") },
    ]);
    await assert.rejects(
      () =>
        installSkillOverlay({
          projectRoot: dir,
          source: "github:acme/skills@v1",
          fetchZip: async () => ({ body: zip }),
        }),
      (err) => {
        assert.equal(err instanceof AgentError, true);
        assert.match(err.message, /minisign signature/);
        return true;
      },
    );
  });
});

test("remote bad minisign signature refuses via verifyMinisign", async () => {
  await withTempDir(async (dir) => {
    const signature = await readFile(join(minisignFixture, "sha256.hex.minisig"), "utf8");
    const zip = makeZip([
      { name: "skills-v1/execute/SKILL.md", data: skillMarkdown("execute") },
      { name: "skills-v1/execute/sha256.hex.minisig", data: signature },
    ]);
    await assert.rejects(
      () =>
        installSkillOverlay({
          projectRoot: dir,
          source: "github:acme/skills@v1",
          fetchZip: async () => ({ body: zip }),
        }),
      (err) => {
        assert.equal(err instanceof MinisignError, true);
        assert.match(err.message, /minisign/);
        return true;
      },
    );
  });
});

test("remote integrity mismatch refuses after verifying minisign", async () => {
  await withTempDir(async (dir) => {
    const declared = (await readFile(join(minisignFixture, "sha256.hex"), "utf8")).trim();
    const signature = await readFile(join(minisignFixture, "sha256.hex.minisig"), "utf8");
    const zip = makeZip([
      { name: "skills-v1/execute/SKILL.md", data: skillMarkdown("execute") },
      { name: "skills-v1/execute/sha256.hex", data: declared },
      { name: "skills-v1/execute/sha256.hex.minisig", data: signature },
    ]);
    await assert.rejects(
      () =>
        installSkillOverlay({
          projectRoot: dir,
          source: "github:acme/skills@v1",
          fetchZip: async () => ({ body: zip }),
        }),
      (err) => {
        assert.equal(err instanceof AgentError, true);
        assert.match(err.message, /integrity mismatch/);
        return true;
      },
    );
  });
});

test("folder pwned with skillId execute refuses", async () => {
  await withTempDir(async (dir) => {
    const src = join(dir, "pwned");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), skillMarkdown("execute"), "utf8");
    await assert.rejects(
      () => installSkillOverlay({ projectRoot: dir, source: src, unsigned: true }),
      (err) => {
        assert.equal(err instanceof AgentError, true);
        assert.match(err.message, /must equal directory "pwned" and skillId "execute"/);
        return true;
      },
    );
  });
});

test("multi-skill bundle without --skill refuses", async () => {
  await withTempDir(async (dir) => {
    const src = join(dir, "bundle");
    await mkdir(join(src, "execute"), { recursive: true });
    await mkdir(join(src, "plan"), { recursive: true });
    await writeFile(join(src, "execute", "SKILL.md"), skillMarkdown("execute"), "utf8");
    await writeFile(join(src, "plan", "SKILL.md"), skillMarkdown("plan"), "utf8");
    await assert.rejects(
      () => installSkillOverlay({ projectRoot: dir, source: src, unsigned: true }),
      (err) => {
        assert.equal(err instanceof AgentError, true);
        assert.match(err.message, /multi-skill bundle requires --skill/);
        return true;
      },
    );
    const installed = await installSkillOverlay({
      projectRoot: dir,
      source: src,
      unsigned: true,
      skillId: "execute",
    });
    assert.equal(installed.skillId, "execute");
  });
});

test("github root-level SKILL.md uses frontmatter skillId not tmp dir name", async () => {
  await withTempDir(async (dir) => {
    const zip = makeZip([{ name: "skills-v1/SKILL.md", data: skillMarkdown("execute") }]);
    await assert.rejects(
      () =>
        installSkillOverlay({
          projectRoot: dir,
          source: "github:acme/skills@v1",
          skillId: "execute",
          fetchZip: async () => ({ body: zip }),
        }),
      (err) => {
        assert.equal(err instanceof AgentError, true);
        assert.match(err.message, /minisign signature/);
        assert.doesNotMatch(err.message, /does not contain execute/);
        assert.doesNotMatch(err.message, /must equal directory/);
        return true;
      },
    );
    await assert.rejects(
      () =>
        installSkillOverlay({
          projectRoot: dir,
          source: "github:acme/skills@v1",
          fetchZip: async () => ({ body: zip }),
        }),
      (err) => {
        assert.equal(err instanceof AgentError, true);
        assert.match(err.message, /minisign signature/);
        assert.doesNotMatch(err.message, /must equal directory/);
        return true;
      },
    );
  });
});

test("unsigned local install with --integrity compares dest digest", async () => {
  await withTempDir(async (dir) => {
    const src = join(dir, "execute");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), skillMarkdown("execute"), "utf8");
    const sha256 = await hashSkillTree(src);
    await assert.rejects(
      () =>
        installSkillOverlay({
          projectRoot: dir,
          source: src,
          unsigned: true,
          integritySha256: "a".repeat(64),
        }),
      /integrity mismatch/,
    );
    const installed = await installSkillOverlay({
      projectRoot: dir,
      source: src,
      unsigned: true,
      integritySha256: sha256,
    });
    assert.equal(installed.pin.integrity.sha256, sha256);
  });
});

test("reinstall from overlay dest does not delete the source before copy", async () => {
  await withTempDir(async (dir) => {
    const src = join(dir, "execute");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), skillMarkdown("execute", { description: "first overlay" }), "utf8");
    await installSkillOverlay({ projectRoot: dir, source: src, unsigned: true });
    const dest = overlaySkillDir(dir, "execute");
    const again = await installSkillOverlay({ projectRoot: dir, source: dest, unsigned: true });
    assert.equal(again.skillId, "execute");
    assert.equal(existsSync(join(dest, "SKILL.md")), true);
    assert.match(await readFile(join(dest, "SKILL.md"), "utf8"), /first overlay/);
  });
});

test("overlay dest refuses symlink ancestors", async () => {
  await withTempDir(async (dir) => {
    const outside = join(dir, "outside");
    const src = join(dir, "execute");
    await mkdir(outside, { recursive: true });
    await mkdir(join(dir, ".legion-cli"), { recursive: true });
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), skillMarkdown("execute"), "utf8");
    await symlink(outside, join(dir, ".legion-cli", "skills"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      () => installSkillOverlay({ projectRoot: dir, source: src, unsigned: true }),
      (err) => {
        assert.equal(err instanceof PathEscapeError, true);
        return true;
      },
    );
    assert.equal(existsSync(join(outside, "execute")), false);
  });
});

test("resolved catalog prefers overlay description", async () => {
  await withTempDir(async (dir) => {
    const packaged = join(dir, "skills");
    await mkdir(join(packaged, "execute"), { recursive: true });
    await writeFile(join(packaged, "execute", "SKILL.md"), skillMarkdown("execute", { description: "packaged execute" }), "utf8");
    const overlay = overlaySkillDir(dir, "execute");
    await mkdir(overlay, { recursive: true });
    await writeFile(
      join(overlay, "SKILL.md"),
      skillMarkdown("execute", { description: "OVERLAY_EXECUTE_DESC_TOKEN" }),
      "utf8",
    );
    const sha256 = await hashSkillTree(overlay);
    await writeFile(
      join(overlay, "overlay.json"),
      `${JSON.stringify({
        schemaVersion: "legion-cli-skill-overlay/v1",
        skillId: "execute",
        source: { type: "local", origin: overlay },
        integrity: { sha256 },
        installedAt: "2026-09-17T00:00:00Z",
      })}\n`,
      "utf8",
    );
    const listed = await listResolvedSkillCatalog({ projectRoot: dir, packagedSkillsDir: packaged });
    const execute = listed.catalog.skills.find((skill) => skill.skillId === "execute");
    assert.equal(execute.description, "OVERLAY_EXECUTE_DESC_TOKEN");
    assert.equal(execute.path, ".legion-cli/skills/execute/SKILL.md");
  });
});
