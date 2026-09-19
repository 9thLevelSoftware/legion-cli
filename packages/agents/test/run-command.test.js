import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  ARGV_ONLY_MESSAGE,
  isSecretEnvName,
  parseCommandLine,
  runCommand,
  scrubSecretsEnv,
  splitCommand,
} from "../dist/index.js";
import { withTempDir } from "./helpers.js";

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
    "GOOGLE_APPLICATION_CREDENTIALS", "AWS_ACCESS_KEY_ID", "SSH_AUTH_SOCK", "npm_config__auth", "NPM_CONFIG__AUTHTOKEN"]) {
    assert.equal(isSecretEnvName(name), true, name);
  }
  for (const name of ["DATABASE_URL", "PATH", "HOME", "MONKEY", "NODE_ENV", "PNPM_HOME"]) {
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
