import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pkgRoot } from "./helpers.js";

const repoRoot = join(pkgRoot, "..", "..");
const copyScript = join(repoRoot, "scripts", "copy-skills.mjs");
const allowlistScript = join(repoRoot, "scripts", "check-publish-allowlist.mjs");

function node(script, args, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true, ...opts });
}

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-cli-packaging-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("copy-skills bundles every skill folder and --clean removes the copy (F-025)", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "skills");
    const copied = node(copyScript, ["--target", target]);
    assert.equal(copied.status, 0, copied.stderr);
    for (const skill of ["interview", "discuss", "spec", "plan", "execute", "verify", "review", "qa"]) {
      assert.ok(existsSync(join(target, skill, "SKILL.md")), `${skill}/SKILL.md bundled`);
    }
    const cleaned = node(copyScript, ["--clean", "--target", target]);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(existsSync(target), false);
  });
});

test("the agents package publishes skills/ and packs them (F-025)", async () => {
  const manifest = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
  assert.ok(manifest.files.includes("skills"), "package.json files lists skills");
  assert.match(manifest.scripts.prepack, /copy-skills/);
  assert.match(manifest.scripts.postpack, /copy-skills\.mjs --clean/);
  // Pack a scratch copy of the layout (scripts/, skills/, packages/agents/{package.json,dist}) so the
  // prepack copy never appears inside this checkout while sibling tests run. npm runs prepack and
  // postpack even for --dry-run, so this proves the tarball content without a registry.
  await withTmp(async (dir) => {
    await cp(join(repoRoot, "scripts"), join(dir, "scripts"), { recursive: true });
    await cp(join(repoRoot, "skills"), join(dir, "skills"), { recursive: true });
    const pkgDir = join(dir, "packages", "agents");
    await mkdir(pkgDir, { recursive: true });
    await cp(join(pkgRoot, "package.json"), join(pkgDir, "package.json"));
    await cp(join(pkgRoot, "dist"), join(pkgDir, "dist"), { recursive: true });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = spawnSync(npm, ["pack", "--dry-run", "--json"], {
      cwd: pkgDir,
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
    });
    assert.equal(packed.status, 0, packed.stderr);
    const files = JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")))[0].files.map((file) =>
      file.path.replaceAll("\\", "/"),
    );
    for (const skill of ["interview", "plan", "execute", "review"]) {
      assert.ok(files.includes(`skills/${skill}/SKILL.md`), `tarball has skills/${skill}/SKILL.md`);
    }
    assert.ok(files.includes("dist/index.js"));
    assert.equal(existsSync(join(pkgDir, "skills")), false, "postpack removed the copy");
  });
});

test("publish allowlist check passes for the repo and fails for an unlisted package (F-072)", async () => {
  const real = node(allowlistScript, []);
  assert.equal(real.status, 0, real.stderr);
  await withTmp(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "root", private: true, legionPublishAllowlist: ["@x/a"] }));
    for (const [folder, pkg] of [
      ["a", { name: "@x/a" }],
      ["b", { name: "@x/b" }],
      ["c", { name: "@x/c", private: true }],
    ]) {
      await mkdir(join(dir, "packages", folder), { recursive: true });
      await writeFile(join(dir, "packages", folder, "package.json"), JSON.stringify(pkg));
    }
    const failed = node(allowlistScript, [dir]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /@x\/b/);
    assert.doesNotMatch(failed.stderr, /@x\/c/);
    // Listing a name that is not a package is also a failure (a typo would otherwise pass silently).
    await writeFile(join(dir, "packages", "b", "package.json"), JSON.stringify({ name: "@x/b", private: true }));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "root", private: true, legionPublishAllowlist: ["@x/a", "@x/typo"] }),
    );
    const stale = node(allowlistScript, [dir]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /@x\/typo/);
  });
});

test("publish.yml runs the allowlist check before publishing", async () => {
  const workflow = await readFile(join(repoRoot, ".github", "workflows", "publish.yml"), "utf8");
  const check = workflow.indexOf("check-publish-allowlist.mjs");
  const publish = workflow.indexOf("pnpm publish");
  assert.ok(check > 0 && publish > check, "allowlist check runs before pnpm publish");
});
