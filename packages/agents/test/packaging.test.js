import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { pkgRoot } from "./helpers.js";

const repoRoot = join(pkgRoot, "..", "..");
const copyScript = join(repoRoot, "scripts", "copy-skills.mjs");
const allowlistScript = join(repoRoot, "scripts", "check-publish-allowlist.mjs");
const bumpVersionScript = join(repoRoot, "scripts", "bump-version.mjs");

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

test("publish.yml runs the allowlist check with --release-tag before publishing", async () => {
  const workflow = await readFile(join(repoRoot, ".github", "workflows", "publish.yml"), "utf8");
  const check = workflow.indexOf("check-publish-allowlist.mjs");
  const publish = workflow.indexOf("pnpm publish");
  assert.ok(check > 0 && publish > check, "allowlist check runs before pnpm publish");
  assert.match(workflow, /check-publish-allowlist\.mjs --release-tag/);
});

test("check-publish-allowlist detects repository.url mismatches", async () => {
  await withTmp(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "root", private: true, legionPublishAllowlist: ["@x/a"] }));
    await mkdir(join(dir, "packages", "a"), { recursive: true });
    await writeFile(
      join(dir, "packages", "a", "package.json"),
      JSON.stringify({
        name: "@x/a",
        version: "0.0.0",
        repository: { type: "git", url: "git+https://github.com/9thLevelSoftware/product-engineer-helper.git" },
      }),
    );
    const mismatch = node(allowlistScript, [dir]);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /repository\.url/);
    assert.match(mismatch.stderr, /@x\/a/);

    await writeFile(
      join(dir, "packages", "a", "package.json"),
      JSON.stringify({
        name: "@x/a",
        version: "0.0.0",
        repository: { type: "git", url: "git+https://github.com/9thLevelSoftware/legion-cli.git" },
      }),
    );
    const fixed = node(allowlistScript, [dir]);
    assert.equal(fixed.status, 0, fixed.stderr);
  });
});

test("check-publish-allowlist --release-tag validates tag format, package versions, Cargo.toml, and LICENSE", async () => {
  await withTmp(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "root", private: true, legionPublishAllowlist: ["@x/a"] }));
    await mkdir(join(dir, "packages", "a"), { recursive: true });
    await mkdir(join(dir, "packages", "sandbox", "native"), { recursive: true });
    await writeFile(join(dir, "LICENSE"), "MIT License\n");
    await writeFile(
      join(dir, "packages", "a", "package.json"),
      JSON.stringify({
        name: "@x/a",
        version: "0.1.0",
        repository: { type: "git", url: "git+https://github.com/9thLevelSoftware/legion-cli.git" },
      }),
    );
    await writeFile(
      join(dir, "packages", "sandbox", "native", "Cargo.toml"),
      '[workspace]\nmembers = ["."]\n\n[workspace.package]\nversion = "0.1.0"\n\n[package]\nname = "legion-wasi-host"\nversion.workspace = true\n',
    );

    const valid = node(allowlistScript, [dir, "--release-tag", "v0.1.0"]);
    assert.equal(valid.status, 0, valid.stderr);

    const badTag = node(allowlistScript, [dir, "--release-tag", "0.1.0"]);
    assert.equal(badTag.status, 1);
    assert.match(badTag.stderr, /invalid --release-tag/);

    const zeroTag = node(allowlistScript, [dir, "--release-tag", "v0.0.0"]);
    assert.equal(zeroTag.status, 1);
    assert.match(zeroTag.stderr, /0\.0\.0/);

    const versionMismatch = node(allowlistScript, [dir, "--release-tag", "v0.2.0"]);
    assert.equal(versionMismatch.status, 1);
    assert.match(versionMismatch.stderr, /version mismatch for @x\/a/);
    assert.match(versionMismatch.stderr, /Cargo\.toml/);

    await rm(join(dir, "LICENSE"));
    const missingLicense = node(allowlistScript, [dir, "--release-tag", "v0.1.0"]);
    assert.equal(missingLicense.status, 1);
    assert.match(missingLicense.stderr, /LICENSE/);
  });
});

test("bump-version updates package manifests, Cargo.toml, and Cargo.lock in lockstep", async () => {
  await withTmp(async (dir) => {
    await cp(join(repoRoot, "package.json"), join(dir, "package.json"));
    await cp(join(repoRoot, "LICENSE"), join(dir, "LICENSE"));
    for (const pkgDir of ["cli", "agents", "sandbox"]) {
      await mkdir(join(dir, "packages", pkgDir), { recursive: true });
      await cp(join(repoRoot, "packages", pkgDir, "package.json"), join(dir, "packages", pkgDir, "package.json"));
    }
    await mkdir(join(dir, "packages", "sandbox", "native"), { recursive: true });
    await cp(join(repoRoot, "packages", "sandbox", "native", "Cargo.toml"), join(dir, "packages", "sandbox", "native", "Cargo.toml"));
    await cp(join(repoRoot, "packages", "sandbox", "native", "Cargo.lock"), join(dir, "packages", "sandbox", "native", "Cargo.lock"));
    // Trim root allowlist in the temp fixture to the three copied packages.
    const tempRootPkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    tempRootPkg.legionPublishAllowlist = [
      "@9thlevelsoftware/legion-cli",
      "@9thlevelsoftware/legion-cli-agents",
      "@9thlevelsoftware/legion-cli-sandbox",
    ];
    await writeFile(join(dir, "package.json"), `${JSON.stringify(tempRootPkg, null, 2)}\n`);

    const badSemver = node(bumpVersionScript, ["v0.2.0", dir]);
    assert.equal(badSemver.status, 1);
    assert.match(badSemver.stderr, /invalid semver/);

    const bumped = node(bumpVersionScript, ["0.2.0-rc.1", dir]);
    assert.equal(bumped.status, 0, bumped.stderr);

    const verified = node(allowlistScript, [dir, "--release-tag", "v0.2.0-rc.1"]);
    assert.equal(verified.status, 0, verified.stderr);

    const lock = await readFile(join(dir, "packages", "sandbox", "native", "Cargo.lock"), "utf8");
    for (const crate of ["legion-wasi-host", "legion-json-contract", "legion-pack-component", "legion-strict-json", "legion-component-fixtures"]) {
      assert.match(lock, new RegExp(`\\[\\[package\\]\\]\\r?\\nname = "${crate}"\\r?\\nversion = "0\\.2\\.0-rc\\.1"`));
    }
  });
});

test("an installed layout finds its bundled skills, even with a shadowing skills/ above the cwd (F-025, R-9/R-10)", async () => {
  await withTmp(async (dir) => {
    // <dir>/node_modules/@x/agents/{dist,skills}: the shape npm installs, skills copied by the pack script.
    const pkg = join(dir, "node_modules", "@x", "agents");
    await mkdir(pkg, { recursive: true });
    await cp(join(pkgRoot, "dist"), join(pkg, "dist"), { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@x/agents", type: "module" }));
    const copied = node(copyScript, ["--target", join(pkg, "skills")]);
    assert.equal(copied.status, 0, copied.stderr);
    // The package's own dependencies resolve through the checkout's node_modules.
    await symlink(join(pkgRoot, "node_modules"), join(pkg, "node_modules"), "junction");

    // A project (and an ancestor of it) with its own skills/ that must not shadow the bundled copy.
    const cwd = join(dir, "project", "nested");
    await mkdir(join(dir, "project", "skills", "plan"), { recursive: true });
    await writeFile(join(dir, "project", "skills", "plan", "SKILL.md"), "shadow\n");
    await mkdir(cwd, { recursive: true });

    const env = { ...process.env };
    delete env.LEGION_CLI_SKILLS_DIR;
    const probe = `import(${JSON.stringify(pathToFileURL(join(pkg, "dist", "index.js")).href)}).then((m) => console.log(m.findSkillsDir()))`;
    const run = spawnSync(process.execPath, ["-e", probe], { cwd, env, encoding: "utf8", windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(realpathSync(run.stdout.trim()), realpathSync(join(pkg, "skills")));

    // The explicit override still wins.
    const override = spawnSync(process.execPath, ["-e", probe], {
      cwd,
      env: { ...env, LEGION_CLI_SKILLS_DIR: join(dir, "project", "skills") },
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(override.stdout.trim(), join(dir, "project", "skills"));
  });
});
