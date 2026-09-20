import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { controlDirPath } from "@9thlevelsoftware/legion-cli-persist";

/** Control records and quarantine go to a throwaway per-user state dir (KD-2), inherited by the CLI. */
if (!process.env.LEGION_CLI_STATE_DIR) {
  const stateDir = mkdtempSync(join(tmpdir(), "legion-state-"));
  process.env.LEGION_CLI_STATE_DIR = stateDir;
  process.once("exit", () => {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
}

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const bin = join(pkgRoot, "dist", "bin.js");
export const transcriptsDir = join(pkgRoot, "test", "transcripts");

export function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    windowsHide: true,
    input: opts.input,
  });
}

export function normalize(text) {
  return (text ?? "").replaceAll("\r\n", "\n");
}

export function readGolden(name) {
  return readFile(join(transcriptsDir, name), "utf8").then((text) => normalize(text));
}

export function sanitizeDoctor(text) {
  return normalize(text)
    .replace(/^(ok  |FAIL)  Node >= 22 \(.+\)$/m, "$1  Node >= 22 (<version>)")
    .replace(/^(ok  |FAIL)  pnpm \(.+\)$/m, "$1  pnpm (<version>)")
    .replace(/^(ok  |FAIL)  git \(.+\)$/m, "$1  git (<version>)")
    .replace(/^  legion-cli\n(?:    .+\n)+/m, "  legion-cli\n    <paths>\n")
    .replace(/^  legion\n(?:    .+\n)+/m, "  legion\n    <paths>\n")
    .replace(/^(ok  |FAIL)  sandbox \(.+\)$/m, "$1  sandbox (<backend>)")
    .replace(/^Sandbox     .+$/m, "Sandbox     <backend>")
    .replace(/^Playwright  .+$/m, "Playwright  <playwright>")
    .replace(/^  claude       .+$/m, "  claude       <detect>")
    .replace(/^  grok         .+$/m, "  grok         <detect>")
    .replace(/^  openai       .+$/m, "  openai       <detect>")
    .replace(/^  codex        .+$/m, "  codex        <detect>")
    .replace(/^  mimo         .+$/m, "  mimo         <detect>")
    .replace(/^  minimax      .+$/m, "  minimax      <detect>")
    .replace(/\nWarnings\n(?:  .+\n?)*(?:\n)?/g, "\n");
}

function gitIn(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

/** A child process that stays alive until `stop()`: stands in for another engine's agent run. */
export function spawnSleeper() {
  const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return {
    pid: proc.pid,
    stop: () =>
      new Promise((done) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return done();
        proc.once("exit", () => done());
        proc.kill();
      }),
  };
}

/** Control records of another process's live run (`<userStateDir>/control/<hash>/<runId>/`). */
export async function writeLiveControlRecords(dir, runId, skillId, pid) {
  const target = controlDirPath(dir, runId);
  await mkdir(target, { recursive: true });
  const startedAt = new Date().toISOString();
  await writeFile(
    join(target, "resume.json"),
    `${JSON.stringify({
      schemaVersion: "legion-cli-resume/v1",
      runId,
      taskId: null,
      skillId,
      preSpawnRef: "UNBORN",
      startedAt,
      timeoutMs: 1_200_000,
      pid,
      enginePid: pid,
      engineStartedAt: Date.now(),
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(target, "live.json"),
    `${JSON.stringify({ runId, skillId, enginePid: pid, engineStartedAt: Date.now(), startedAt, timeoutMs: 1_200_000 })}\n`,
    "utf8",
  );
  return target;
}

/** A git repo with one empty commit: agent spawns need a repo with a commit (KD-3, F-013). */
export function initEmptyGitRepo(dir) {
  gitIn(dir, ["init"]);
  gitIn(dir, ["config", "user.name", "9thLevelSoftware"]);
  gitIn(dir, ["config", "user.email", "engineering@9thlevelsoftware.com"]);
  gitIn(dir, ["commit", "--allow-empty", "-m", "initial"]);
}

/** Temp project dir. By default it is a git repo with one empty commit; `{ git: false }` opts out. */
export async function withTempDir(fn, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), "legion-cli-"));
  try {
    if (opts.git !== false) initEmptyGitRepo(dir);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Omit {{pointer}} so PATH cannot green-light grok in CLI-override tests. */
export function withUnspawnableGrok(config) {
  return {
    ...config,
    adapter: {
      ...config.adapter,
      grok: { args: ["--model", "grok-4"] },
    },
  };
}

export async function allowCopyJail(store) {
  const config = await store.readConfig();
  await store.writeConfig({
    ...config,
    sandbox: { ...config.sandbox, allowCopyJail: true },
  });
}

/**
 * Seed `sandbox.allowCopyJail: true` in an initialized project so doctor's sandbox
 * check passes on hosts without bwrap/seatbelt (Windows). Use it in doctor tests whose
 * subject is not the sandbox; the sandbox FAIL path has its own deterministic test.
 */
export async function allowCopyJailIn(dir) {
  await allowCopyJail(createLegionEngine(dir).store);
}

export function withNamedAdapter(config, name, id) {
  return {
    ...config,
    adapter: {
      ...config.adapter,
      named: { ...(config.adapter.named ?? {}), [name]: id },
    },
  };
}
