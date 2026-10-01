import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "legion-consumer-"));
function run(binary, args, cwd) {
  let executable = binary;
  let argv = args;
  if (process.platform === "win32" && binary !== process.execPath) {
    // Invoke package-manager JavaScript directly; .cmd shells cannot safely carry
    // arbitrary consumer paths (spaces, percent signs, or metacharacters).
    const manager = binary === "pnpm"
      ? process.env.npm_execpath
      : join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!manager || (binary === "pnpm" && !/pnpm\.(?:c?js)$/i.test(manager))) {
      throw new Error("Run this smoke through pnpm smoke:consumer on Windows");
    }
    executable = process.execPath;
    argv = [manager, ...args];
  }
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^npm_config_allow[-_]scripts(?:[-_].*)?$/i.test(key)));
  const result = spawnSync(executable, argv, {
    cwd, encoding: "utf8", windowsHide: true,
    shell: false,
    env: { ...environment, LEGION_CLI_ADAPTER: "fake", LEGION_CLI_SKILLS_DIR: "", LEGION_CLI_CRAFT_DIR: "", LEGION_CLI_EXTENSIONS_DIR: "" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${binary} ${args[0]} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.private, true);
  const allowlist = new Set(manifest.legionPublishAllowlist);
  const packs = join(temporary, "packs");
  const consumer = join(temporary, "consumer");
  await mkdir(packs);
  await mkdir(consumer);
  const npmConfig = join(temporary, "npmrc");
  await writeFile(npmConfig, ""); // A clean consumer must not inherit machine-specific npm install policy.
  const packed = [];
  for (const directory of (await readdir(join(root, "packages"))).sort()) {
    const packageRoot = join(root, "packages", directory);
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (!allowlist.has(packageJson.name)) continue;
    assert.notEqual(packageJson.private, true);
    run("pnpm", ["pack", "--pack-destination", packs], packageRoot);
    packed.push(packageJson.name);
  }
  assert.equal(packed.length, allowlist.size, "all allowlisted packages must be packed");
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "legion-clean-consumer", private: true, type: "module" }));
  const tarballs = (await readdir(packs)).filter((name) => name.endsWith(".tgz")).sort().map((name) => join(packs, name));
  // Install all packages together so 0.0.0 dependencies resolve locally, without workspace links.
  run("npm", ["install", "--userconfig", npmConfig, "--no-audit", "--no-fund", ...tarballs], consumer);
  const installed = join(consumer, "node_modules", "@9thlevelsoftware");
  for (const name of packed) assert.ok((await realpath(join(consumer, "node_modules", name))).startsWith(await realpath(consumer)));
  const bin = join(installed, "legion-cli", "dist", "bin.js");
  const help = run(process.execPath, [bin, "help", "--all"], consumer);
  assert.match(help, /execute/);
  const project = join(consumer, "project");
  await mkdir(project);
  const initialized = JSON.parse(run(process.execPath, [bin, "init", "--adapter", "fake", "--name", "Consumer", "--project", project, "--json"], consumer));
  assert.notEqual(initialized.ok, false);
  const status = JSON.parse(run(process.execPath, [bin, "status", "--project", project, "--json"], consumer));
  assert.notEqual(status.ok, false);
  const skills = JSON.parse(run(process.execPath, [bin, "skills", "list", "--project", project, "--json"], consumer));
  assert.match(JSON.stringify(skills), /execute/);
  assert.match(JSON.stringify(skills), /accessibility/, "extension packs must ship in the installed package");
  const craft = await readFile(join(project, ".legion-cli", "design", "craft", "typography.md"), "utf8");
  assert.ok(craft.length > 0);
  const brownfield = run(process.execPath, [bin, "help", "brownfield"], consumer);
  assert.match(brownfield, /brownfield/);
  console.log(JSON.stringify({ ok: true, packages: packed, checks: ["local tarball installation", "no workspace links", "installed help", "init", "status JSON", "skill resources", "extension resources", "craft resources", "brownfield help"] }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
