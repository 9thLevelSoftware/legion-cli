import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PathEscapeError } from "@9thlevelsoftware/legion-cli-persist";
import { LegionConfigSchema } from "@9thlevelsoftware/legion-cli-schema";

import { assertExecuteSandbox, detectSandbox, materializeJail, SandboxError } from "../dist/index.js";

const HARDENED_REQUIRED =
  "hardened sandbox required (bwrap or seatbelt); copy jail refused without allowNoSandbox or sandbox.allowCopyJail";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-sandbox-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function withPath(pathValue, fn) {
  const prevPath = process.env.PATH;
  const prevWin = process.env.Path;
  process.env.PATH = pathValue;
  if (process.platform === "win32") process.env.Path = pathValue;
  try {
    return fn();
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (process.platform === "win32") {
      if (prevWin === undefined) delete process.env.Path;
      else process.env.Path = prevWin;
    }
  }
}

function makeConfig(sandbox = {}) {
  return LegionConfigSchema.parse({
    schemaVersion: "legion-cli-config/v1",
    adapter: { default: "fake" },
    sandbox,
  });
}

function policy(dir, overrides = {}) {
  return {
    projectRoot: dir,
    runId: "run-1",
    allowedWrites: ["src/main.ts"],
    readSet: ["src/read.ts"],
    network: "deny",
    adapterBinary: process.execPath,
    ...overrides,
  };
}

async function seedProject(dir) {
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(dir, ".git", "hooks"), { recursive: true });
  await writeFile(join(dir, "src", "main.ts"), "export const main = 1;\n", "utf8");
  await writeFile(join(dir, "src", "read.ts"), "export const read = 1;\n", "utf8");
  await writeFile(join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");
  await writeFile(join(dir, ".git", "hooks", "keep"), "keep\n", "utf8");
}

function spawnInJail(handle, script) {
  const opts = handle.spawnOpts();
  const command = process.execPath;
  const args = ["-e", script];
  const spawnOpts = { cwd: opts.cwd, env: opts.env, encoding: "utf8", windowsHide: true, shell: false };
  if (opts.wrapper) {
    return spawnSync(opts.wrapper.bin, [...opts.wrapper.argvPrefix, command, ...args], spawnOpts);
  }
  return spawnSync(command, args, spawnOpts);
}

test("copy-out drops writes outside allowedWrites", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(policy(dir));
    try {
      await mkdir(join(handle.jailRoot, "src"), { recursive: true });
      await writeFile(join(handle.jailRoot, "src", "secret.ts"), "steal\n", "utf8");
      await writeFile(join(handle.jailRoot, "src", "main.ts"), "export const main = 2;\n", "utf8");
      const result = await handle.copyOut();
      assert.ok(result.copied.includes("src/main.ts"));
      assert.ok(!result.copied.includes("src/secret.ts"));
      assert.ok(result.dropped.includes("src/secret.ts"));
      assert.equal(await readFile(join(dir, "src", "main.ts"), "utf8"), "export const main = 2;\n");
      assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
    } finally {
      await handle.destroy();
    }
  });
});

test("copy-out includes an allowed write that did not exist yet", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(
      policy(dir, { allowedWrites: ["src/main.ts", "src/new.ts"] }),
    );
    try {
      await writeFile(join(handle.jailRoot, "src", "new.ts"), "export const neu = 1;\n", "utf8");
      const result = await handle.copyOut();
      assert.ok(result.copied.includes("src/new.ts"));
      assert.equal(await readFile(join(dir, "src", "new.ts"), "utf8"), "export const neu = 1;\n");
    } finally {
      await handle.destroy();
    }
  });
});

test(".git/hooks write in jail does not appear in operator .git/hooks", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(policy(dir));
    try {
      await mkdir(join(handle.jailRoot, ".git", "hooks"), { recursive: true });
      await writeFile(join(handle.jailRoot, ".git", "hooks", "evil"), "evil\n", "utf8");
      const result = await handle.copyOut();
      assert.ok(result.dropped.includes(".git/hooks/evil"));
      assert.equal(existsSync(join(dir, ".git", "hooks", "evil")), false);
      assert.equal(await readFile(join(dir, ".git", "hooks", "keep"), "utf8"), "keep\n");
    } finally {
      await handle.destroy();
    }
  });
});

test("HOME in spawn env is under .legion-cli/sandbox/", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(policy(dir));
    try {
      const env = handle.spawnOpts().env;
      const home = (env.HOME ?? "").replaceAll("\\", "/");
      assert.match(home, /\.legion-cli\/sandbox\//);
      assert.equal(handle.spawnOpts().cwd, handle.jailRoot);
      assert.match(handle.jailRoot.replaceAll("\\", "/"), /\.legion-cli\/sandbox\/run-1$/);
    } finally {
      await handle.destroy();
    }
  });
});

test("requireHardened + only copy + no allowNoSandbox refuses", () => {
  const config = makeConfig({ backend: "copy" });
  assert.throws(
    () => assertExecuteSandbox(config, {}),
    (err) => {
      assert.equal(err instanceof SandboxError, true);
      assert.equal(err.name, "SandboxError");
      assert.equal(err.message, HARDENED_REQUIRED);
      return true;
    },
  );
  assert.doesNotThrow(() => assertExecuteSandbox(config, { allowNoSandbox: true }));
  assert.doesNotThrow(() => assertExecuteSandbox(makeConfig({ backend: "copy", allowCopyJail: true }), {}));
  assert.doesNotThrow(() => assertExecuteSandbox(makeConfig({ backend: "copy", requireHardened: false }), {}));
});

test("bwrap missing: detect returns copy, hardened false", () => {
  withPath("", () => {
    const detected = detectSandbox();
    assert.equal(detected.backend, "copy");
    assert.equal(detected.hardened, false);
    assert.throws(
      () => assertExecuteSandbox(makeConfig(), {}),
      (err) => {
        assert.equal(err.name, "SandboxError");
        assert.equal(err.message, HARDENED_REQUIRED);
        return true;
      },
    );
  });
});

test("sandbox env has no SSH_AUTH_SOCK; profile dirs point under jail", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const prevSock = process.env.SSH_AUTH_SOCK;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
    process.env.OPENAI_API_KEY = "sk-test";
    let handle;
    try {
      handle = await materializeJail(policy(dir));
      const env = handle.spawnOpts().env;
      assert.equal(env.SSH_AUTH_SOCK, undefined);
      assert.equal(
        Object.keys(env).some((key) => key.toUpperCase() === "SSH_AUTH_SOCK"),
        false,
      );
      const jailPosix = handle.jailRoot.replaceAll("\\", "/");
      assert.equal((env.APPDATA ?? "").replaceAll("\\", "/").startsWith(jailPosix), true);
      assert.equal((env.LOCALAPPDATA ?? "").replaceAll("\\", "/").startsWith(jailPosix), true);
      assert.equal((env.USERPROFILE ?? "").replaceAll("\\", "/").startsWith(jailPosix), true);
      assert.equal((env.HOME ?? "").replaceAll("\\", "/").startsWith(jailPosix), true);
      assert.equal((env.TEMP ?? "").replaceAll("\\", "/"), `${jailPosix}/tmp`);
      assert.equal((env.GIT_DIR ?? "").replaceAll("\\", "/"), `${jailPosix}/.git-null`);
      assert.equal(env.OPENAI_API_KEY, "sk-test");
    } finally {
      if (prevSock === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = prevSock;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      if (handle) await handle.destroy();
    }
  });
});

test("jailed process reads readSet; readSet-only write is dropped on copy-out", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(policy(dir));
    try {
      const script = [
        "const fs = require('fs');",
        "process.stdout.write(fs.readFileSync('src/read.ts', 'utf8'));",
        "fs.writeFileSync('src/read.ts', 'mutated\\n');",
        "fs.writeFileSync('src/main.ts', 'export const main = 3;\\n');",
        "fs.writeFileSync('src/secret.ts', 'steal\\n');",
        "fs.mkdirSync('.git/hooks', { recursive: true });",
        "fs.writeFileSync('.git/hooks/evil', 'evil\\n');",
      ].join("");
      const spawned = spawnInJail(handle, script);
      assert.equal(spawned.status, 0, `${spawned.stdout}\n${spawned.stderr}`);
      assert.equal(spawned.stdout, "export const read = 1;\n");
      const result = await handle.copyOut();
      assert.ok(result.copied.includes("src/main.ts"));
      assert.ok(result.dropped.includes("src/read.ts"));
      assert.ok(result.dropped.includes("src/secret.ts"));
      assert.equal(await readFile(join(dir, "src", "read.ts"), "utf8"), "export const read = 1;\n");
      assert.equal(await readFile(join(dir, "src", "main.ts"), "utf8"), "export const main = 3;\n");
      assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
      assert.equal(existsSync(join(dir, ".git", "hooks", "evil")), false);
    } finally {
      await handle.destroy();
    }
  });
});

test("copy-in is sparse: no node_modules and no operator .git", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(policy(dir, { readSet: ["src/read.ts", "src"] }));
    try {
      assert.equal(existsSync(join(handle.jailRoot, "node_modules")), false);
      assert.equal(existsSync(join(handle.jailRoot, ".git", "hooks", "keep")), false);
      assert.equal(await readFile(join(handle.jailRoot, "src", "read.ts"), "utf8"), "export const read = 1;\n");
    } finally {
      await handle.destroy();
    }
  });
});

test("policy paths refuse traversal, absolute, and backslash", async () => {
  await withTempDir(async (dir) => {
    const base = {
      projectRoot: dir,
      runId: "run-1",
      network: "deny",
      readSet: [],
      allowedWrites: [],
    };
    await assert.rejects(() => materializeJail({ ...base, allowedWrites: ["../secret"] }), PathEscapeError);
    await assert.rejects(() => materializeJail({ ...base, allowedWrites: ["/etc/passwd"] }), PathEscapeError);
    await assert.rejects(() => materializeJail({ ...base, allowedWrites: ["src\\secret.ts"] }), PathEscapeError);
    await assert.rejects(() => materializeJail({ ...base, readSet: [".."] }), PathEscapeError);
    await assert.rejects(() => materializeJail({ ...base, runId: "../out" }), PathEscapeError);
    await assert.rejects(() => materializeJail({ ...base, runId: "a/b" }), PathEscapeError);
    await assert.rejects(() => materializeJail({ ...base, allowedWrites: ["C:/Windows/notepad.exe"] }), PathEscapeError);
  });
});

test("bwrap wrapper omits unshare-net and binds hosts/nsswitch/passwd/group", async (t) => {
  const detected = detectSandbox();
  if (detected.backend !== "bwrap" || !detected.hardened) {
    t.skip("bwrap not available");
    return;
  }
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(policy(dir));
    try {
      const opts = handle.spawnOpts();
      assert.equal(handle.backend, "bwrap");
      assert.equal(handle.hardened, true);
      assert.ok(opts.wrapper);
      assert.match(opts.wrapper.bin.replaceAll("\\", "/"), /bwrap$/);
      const prefix = opts.wrapper.argvPrefix;
      assert.ok(prefix.includes("--die-with-parent"));
      assert.ok(prefix.includes("--unshare-user"));
      assert.ok(prefix.includes("--unshare-pid"));
      assert.ok(prefix.includes("--unshare-uts"));
      assert.ok(prefix.includes("--unshare-ipc"));
      assert.ok(!prefix.includes("--unshare-net"));
      assert.ok(prefix.includes("/etc/hosts"));
      assert.ok(prefix.includes("/etc/nsswitch.conf"));
      assert.ok(prefix.includes("/etc/passwd"));
      assert.ok(prefix.includes("/etc/group"));
      assert.equal(prefix.at(-1), "--");
    } finally {
      await handle.destroy();
    }
  });
});

test("assertExecuteSandbox allows a hardened backend", (t) => {
  const detected = detectSandbox();
  if (!detected.hardened) {
    t.skip("no hardened sandbox on this host");
    return;
  }
  assert.doesNotThrow(() => assertExecuteSandbox(makeConfig(), {}));
});
