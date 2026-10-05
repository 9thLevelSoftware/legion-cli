import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function launch(binary, args, extraEnv) {
  let executable = binary;
  let argv = args;
  if (process.platform === "win32" && binary !== process.execPath) {
    // Invoke package-manager JavaScript directly; .cmd shells cannot safely carry
    // arbitrary consumer paths (spaces, percent signs, or metacharacters).
    const manager = binary === "pnpm"
      ? process.env.npm_execpath
      : join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!manager || (binary === "pnpm" && !/pnpm\.(?:c?js)$/i.test(manager))) {
      throw new Error("Run this smoke through pnpm (for example pnpm smoke:consumer) on Windows");
    }
    executable = process.execPath;
    argv = [manager, ...args];
  }
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^npm_config_allow[-_]scripts(?:[-_].*)?$/i.test(key)));
  return {
    executable,
    argv,
    env: { ...environment, LEGION_CLI_ADAPTER: "fake", LEGION_CLI_SKILLS_DIR: "", LEGION_CLI_CRAFT_DIR: "", LEGION_CLI_EXTENSIONS_DIR: "", ...extraEnv },
  };
}

function run(binary, args, cwd, input, extraEnv = {}) {
  const { executable, argv, env } = launch(binary, args, extraEnv);
  return spawnSync(executable, argv, {
    cwd, encoding: "utf8", windowsHide: true, shell: false, input, env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Same launch and environment as `run`, without blocking the event loop, so in-process loopback
 * servers keep answering while the installed CLI runs. Resolves `{ status, stdout, stderr }`.
 */
function runAsync(binary, args, cwd, input, extraEnv = {}) {
  const { executable, argv, env } = launch(binary, args, extraEnv);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, argv, { cwd, windowsHide: true, shell: false, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", rejectRun);
    child.on("close", (status, signal) => resolveRun({
      status: status ?? (signal ? 128 : null),
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.on("error", () => undefined); // A child may exit before reading its (possibly empty) input.
    child.stdin.end(input ?? "");
  });
}

function runOk(binary, args, cwd, input, extraEnv) {
  const result = run(binary, args, cwd, input, extraEnv);
  if (result.status !== 0) throw new Error(`${binary} ${args[0]} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function runRefused(binary, args, cwd, pattern, extraEnv) {
  const result = run(binary, args, cwd, undefined, extraEnv);
  assert.notEqual(result.status, 0, `${binary} ${args.join(" ")} unexpectedly succeeded`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
  return `${result.stdout}\n${result.stderr}`;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function initGitRepo(project) {
  runGit(["init"], project);
  runGit(["config", "user.name", "Consumer Smoke"], project);
  runGit(["config", "user.email", "consumer-smoke@example.invalid"], project);
  runGit(["add", "-A"], project);
  runGit(["commit", "-m", "initial consumer fixture"], project);
}

/**
 * Pack every allowlisted workspace package, install the tarballs together into a clean consumer
 * (no workspace links), and prove the installed CLI starts. `run`/`runAsync` take an optional extra
 * environment merged over the fixed consumer environment.
 */
export async function installPackedConsumer(root, temporary) {
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
    runOk("pnpm", ["pack", "--pack-destination", packs], packageRoot);
    packed.push(packageJson.name);
  }
  assert.equal(packed.length, allowlist.size, "all allowlisted packages must be packed");
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "legion-clean-consumer", private: true, type: "module" }));
  const tarballs = (await readdir(packs)).filter((name) => name.endsWith(".tgz")).sort().map((name) => join(packs, name));
  // Install all packages together so 0.0.0 dependencies resolve locally, without workspace links.
  runOk("npm", ["install", "--userconfig", npmConfig, "--no-audit", "--no-fund", ...tarballs], consumer);
  const installed = join(consumer, "node_modules", "@9thlevelsoftware");
  for (const name of packed) assert.ok((await realpath(join(consumer, "node_modules", name))).startsWith(await realpath(consumer)));
  const bin = join(installed, "legion-cli", "dist", "bin.js");
  const help = runOk(process.execPath, [bin, "help", "--all"], consumer);
  assert.match(help, /execute/);
  assert.match(help, /ship/);
  const bareHelp = runOk(process.execPath, [bin], consumer);
  assert.match(bareHelp, /phase: uninitialized/);
  assert.match(bareHelp, /Next up:/);
  const bareStatus = JSON.parse(runOk(process.execPath, [bin, "status", "--json"], consumer));
  assert.notEqual(bareStatus.ok, false);
  return { consumer, bin, packed, run, runAsync, runOk, runRefused, runGit, initGitRepo };
}
