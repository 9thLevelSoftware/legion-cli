import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  ARGV_ONLY_MESSAGE,
  cmdExePath,
  cmdScriptLaunch,
  isSecretEnvName,
  parseCommandLine,
  resolveBinary,
  runCommand,
  runTool,
  scrubSecretsEnv,
  splitCommand,
} from "../dist/index.js";
import { pkgRoot, withTempDir } from "./helpers.js";

const SECRETS = {
  FOO_TOKEN: "t0k3n",
  SENDGRID_APIKEY: "sg-key",
  GH_PAT: "ghp-pat",
  npm_config__authToken: "npm-auth",
  MY_PROVIDER_CREDENTIAL_VAR: "configured-api-key",
};

async function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a bare `npm --version` starts and passes (PATHEXT + .cmd shim on Windows)", async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, "npm.log");
    const result = await runCommand(["npm", "--version"], { cwd: dir, timeoutMs: 60_000, logPath });
    assert.equal(result.started, true, result.error);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(await readFile(logPath, "utf8"), /^\d+\.\d+\.\d+/m);
  });
});

test("a missing binary does not start and does not throw", async () => {
  await withTempDir(async (dir) => {
    const result = await runCommand(["legion-no-such-binary-xyz", "--version"], {
      cwd: dir,
      timeoutMs: 10_000,
      logPath: join(dir, "missing.log"),
    });
    assert.equal(result.started, false);
    assert.equal(result.exitCode, null);
    assert.match(result.error, /legion-no-such-binary-xyz: not found on PATH/);
  });
});

test("2 MiB of output is streamed to the log, not buffered", async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, "big.log");
    const result = await runCommand(
      [process.execPath, "-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
      { cwd: dir, timeoutMs: 60_000, logPath },
    );
    assert.equal(result.started, true);
    assert.equal(result.exitCode, 0);
    assert.equal((await readFile(logPath, "utf8")).length, 2 * 1024 * 1024);
  });
});

test("the event loop stays free while a command runs, and a timeout kills it", async () => {
  await withTempDir(async (dir) => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      const result = await runCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        cwd: dir,
        timeoutMs: 500,
        logPath: join(dir, "hang.log"),
      });
      assert.equal(result.started, true);
      assert.equal(result.timedOut, true);
    } finally {
      clearInterval(timer);
    }
    assert.ok(ticks >= 5, `timers ran ${ticks} times during the command`);
  });
});

test("shell operators are refused: commands are argv-only", () => {
  for (const command of ["a && b", "a || b", "a | b", "a; b", "a > out.txt", "a < in.txt", "echo `id`", "echo $(id)"]) {
    const parsed = parseCommandLine(command);
    assert.deepEqual(parsed, { error: ARGV_ONLY_MESSAGE }, command);
  }
  assert.equal(ARGV_ONLY_MESSAGE, "verificationCommands are argv-only; split it into separate commands");
  assert.deepEqual(parseCommandLine(`node -e "a || b"`), { argv: ["node", "-e", "a || b"] });
  assert.deepEqual(parseCommandLine("node -e process.exit(0)"), { argv: ["node", "-e", "process.exit(0)"] });
  assert.deepEqual(splitCommand(`pnpm test -- --reporter=json`), ["pnpm", "test", "--", "--reporter=json"]);
});

test("the default env scrubs credentials and configured apiKeyEnv names, keeps DATABASE_URL", async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "dump-env.js");
    await writeFile(script, "process.stdout.write(JSON.stringify(process.env))\n", "utf8");
    await withEnv({ ...SECRETS, DATABASE_URL: "postgres://fixture" }, async () => {
      const logPath = join(dir, "env.log");
      const result = await runCommand([process.execPath, script], {
        cwd: dir,
        timeoutMs: 30_000,
        logPath,
        secretEnvNames: ["MY_PROVIDER_CREDENTIAL_VAR"],
      });
      assert.equal(result.exitCode, 0);
      const seen = JSON.parse(await readFile(logPath, "utf8"));
      for (const name of Object.keys(SECRETS)) {
        assert.equal(Object.keys(seen).some((key) => key.toUpperCase() === name.toUpperCase()), false, name);
      }
      assert.equal(seen.DATABASE_URL, "postgres://fixture");
      assert.equal(seen.NODE_TEST_CONTEXT, undefined);

      const inherited = join(dir, "inherit.log");
      await runCommand([process.execPath, script], { cwd: dir, timeoutMs: 30_000, logPath: inherited, env: "inherit" });
      assert.equal(JSON.parse(await readFile(inherited, "utf8")).FOO_TOKEN, "t0k3n");
    });
  });
});

test("isSecretEnvName follows the KD-4 pattern", () => {
  for (const name of ["FOO_TOKEN", "SENDGRID_APIKEY", "GH_PAT", "API_KEY", "DB_PASSWORD", "AZURE_CONNECTION_STRING",
    "GOOGLE_APPLICATION_CREDENTIALS", "AWS_ACCESS_KEY_ID", "SSH_AUTH_SOCK", "npm_config__auth", "NPM_CONFIG__AUTHTOKEN",
    "PGPASSWORD", "MYSQL_PWD", "SMTP_PASS", "FTP_PWD", "SYSTEM_ACCESSTOKEN", "MY_ACCESSTOKEN_V2", "DOCKER_AUTH_CONFIG",
    "GIT_ASKPASS", "SSH_ASKPASS", "VSCODE_GIT_IPC_HANDLE", "VSCODE_GIT_ASKPASS_NODE", "SLACK_WEBHOOK_URL"]) {
    assert.equal(isSecretEnvName(name), true, name);
  }
  for (const name of ["DATABASE_URL", "PATH", "HOME", "MONKEY", "NODE_ENV", "PNPM_HOME", "PWD", "OLDPWD", "BYPASS", "COMPASS"]) {
    assert.equal(isSecretEnvName(name), false, name);
  }
  assert.deepEqual(scrubSecretsEnv({ A: "1", X_TOKEN: "2", CUSTOM: "3" }, { extraNames: ["custom"] }), { A: "1" });
});

test("a non-shim .cmd refuses cmd.exe metacharacters in arguments", { skip: process.platform !== "win32" && "Windows cmd.exe only" }, async () => {
  await withTempDir(async (dir) => {
    const cmd = join(dir, "echoargs.cmd");
    await writeFile(cmd, "@echo off\r\necho %*\r\n", "utf8");
    const ok = await runCommand([cmd, "hello", "two words"], { cwd: dir, timeoutMs: 30_000, logPath: join(dir, "ok.log") });
    assert.equal(ok.started, true, ok.error);
    assert.equal(ok.exitCode, 0);
    assert.match(await readFile(join(dir, "ok.log"), "utf8"), /hello "two words"/);
    const refused = await runCommand([cmd, "a&calc"], { cwd: dir, timeoutMs: 30_000, logPath: join(dir, "bad.log") });
    assert.equal(refused.started, false);
    assert.match(refused.error, /& \| < > \^ %/);
  });
});

test("cmdScriptLaunch pins the cmd.exe argv: /d /v:off /s /c, quoted script, outer quotes", () => {
  const launch = cmdScriptLaunch("C:\\Program Files\\nodejs\\pnpm.cmd", ["exec", "two words", ""]);
  assert.deepEqual(launch.args, ["/d", "/v:off", "/s", "/c", '""C:\\Program Files\\nodejs\\pnpm.cmd" exec "two words" """']);
  assert.equal(launch.verbatim, true);
  assert.match(cmdScriptLaunch("C:\\a&b\\run.cmd", []).error, /path containing/);
  assert.match(cmdScriptLaunch("C:\\100%x%\\run.cmd", []).error, /path containing/);
  assert.match(cmdScriptLaunch("C:\\ok\\run.cmd", ["50%"]).error, /argument "50%"/);
});

test("cmd.exe is %ComSpec% when absolute, else %SystemRoot%\\System32\\cmd.exe, never a bare name", () => {
  const saved = { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot };
  try {
    delete process.env.ComSpec;
    process.env.SystemRoot = "C:\\Windows";
    assert.equal(cmdExePath(), "C:\\Windows\\System32\\cmd.exe");
    process.env.ComSpec = "cmd.exe";
    assert.equal(cmdExePath(), "C:\\Windows\\System32\\cmd.exe");
    process.env.ComSpec = "D:\\Tools\\cmd.exe";
    assert.equal(cmdExePath(), "D:\\Tools\\cmd.exe");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("runTool and runCommand run a .cmd whose path contains a space", { skip: process.platform !== "win32" && "Windows cmd.exe only" }, async () => {
  await withTempDir(async (dir) => {
    const spaced = join(dir, "with space");
    await mkdir(spaced, { recursive: true });
    const cmd = join(spaced, "echoargs.cmd");
    await writeFile(cmd, "@echo off\r\necho args:%*\r\n", "utf8");
    const tool = runTool(cmd, ["hello"]);
    assert.equal(tool.status, 0, tool.stderr);
    assert.match(tool.stdout, /args:hello/);
    const logPath = join(dir, "spaced.log");
    const run = await runCommand([cmd, "hello"], { cwd: dir, timeoutMs: 30_000, logPath });
    assert.equal(run.exitCode, 0, run.error);
    assert.match(await readFile(logPath, "utf8"), /args:hello/);
  });
});

test("resolveBinary prefers .exe/.com/.cmd/.bat over an extensionless or .js hit", { skip: process.platform !== "win32" && "Windows PATHEXT only" }, async () => {
  await withTempDir(async (dir) => {
    for (const name of ["legionprobe", "legionprobe.js", "legionprobe.cmd"]) {
      await writeFile(join(dir, name), "@echo off\r\n", "utf8");
    }
    const saved = process.env.PATH;
    process.env.PATH = `${dir};${saved}`;
    try {
      assert.equal(resolveBinary("legionprobe")?.toLowerCase(), join(dir, "legionprobe.cmd").toLowerCase());
    } finally {
      process.env.PATH = saved;
    }
  });
});

test("Ctrl-C on legion-cli also stops a running command's process group", { skip: process.platform === "win32" && "POSIX process groups only" }, async () => {
  await withTempDir(async (dir) => {
    const pidFile = join(dir, "child.pid");
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const script = [
      `const { runCommand } = await import(${JSON.stringify(pathToFileURL(join(pkgRoot, "dist", "index.js")).href)});`,
      `setTimeout(() => process.kill(process.pid, "SIGINT"), 1500);`,
      `await runCommand([process.execPath, "-e", ${JSON.stringify(childCode)}], { cwd: ${JSON.stringify(dir)}, timeoutMs: 60000, logPath: ${JSON.stringify(join(dir, "c.log"))} });`,
    ].join("\n");
    const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
    const exit = await new Promise((done) => parent.once("exit", (code, signal) => done({ code, signal })));
    assert.equal(exit.signal, "SIGINT");
    const childPid = Number(await readFile(pidFile, "utf8"));
    const deadline = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(childPid, 0);
        await new Promise((done) => setTimeout(done, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "the verification child outlived Ctrl-C");
  });
});
