import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { PathEscapeError } from "@9thlevelsoftware/legion-cli-persist";
import { LegionConfigSchema } from "@9thlevelsoftware/legion-cli-schema";

import { assertExecuteSandbox, detectSandbox, materializeJail, SandboxError } from "../dist/index.js";

const HARDENED_REQUIRED =
  "hardened sandbox required (bwrap or seatbelt); copy jail refused without allowNoSandbox or sandbox.allowCopyJail";

const BWRAP_SKIP = "bwrap not on PATH (CI installs bubblewrap on ubuntu-latest)";

const ENV_ALLOW = new Set([
  "PATH",
  "TERM",
  "ComSpec",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "PATHEXT",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "GIT_DIR",
  "CLAUDE_API_KEY",
  "GROK_API_KEY",
  "XAI_API_KEY",
  "OPENAI_API_KEY",
  "MINIMAX_API_KEY",
]);

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

async function trySymlink(target, path, type) {
  try {
    await symlink(target, path, type);
    return true;
  } catch {
    return false;
  }
}

function roBindDests(prefix) {
  const dests = [];
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] === "--ro-bind" && prefix[i + 2] !== undefined) {
      dests.push(prefix[i + 1], prefix[i + 2]);
      i += 2;
    }
  }
  return dests;
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

test("copy-out deletes children missing from an allowed directory", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await mkdir(join(dir, "out", "nested"), { recursive: true });
    await writeFile(join(dir, "out", "keep.txt"), "keep\n", "utf8");
    await writeFile(join(dir, "out", "gone.txt"), "gone\n", "utf8");
    await writeFile(join(dir, "out", "nested", "child.txt"), "child\n", "utf8");
    await writeFile(join(dir, "src", "untouched.ts"), "leave\n", "utf8");
    const handle = await materializeJail(policy(dir, { allowedWrites: ["out"] }));
    try {
      await rm(join(handle.jailRoot, "out", "gone.txt"));
      await rm(join(handle.jailRoot, "out", "nested", "child.txt"));
      const result = await handle.copyOut();
      assert.ok(result.copied.includes("out/gone.txt"));
      assert.ok(result.copied.includes("out/nested/child.txt"));
      assert.equal(existsSync(join(dir, "out", "gone.txt")), false);
      assert.equal(existsSync(join(dir, "out", "nested", "child.txt")), false);
      assert.equal(await readFile(join(dir, "out", "keep.txt"), "utf8"), "keep\n");
      assert.equal(await readFile(join(dir, "src", "untouched.ts"), "utf8"), "leave\n");
    } finally {
      await handle.destroy();
    }
  });
});

test("copy-out does not delete symlink children of an allowed directory", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await mkdir(join(dir, "out"), { recursive: true });
    await writeFile(join(dir, "out", "keep.txt"), "keep\n", "utf8");
    const outside = join(tmpdir(), `legion-dir-del-link-${process.pid}-${Date.now()}.txt`);
    await writeFile(outside, "host-secret\n", "utf8");
    try {
      const linked = await trySymlink(outside, join(dir, "out", "link.txt"));
      const handle = await materializeJail(policy(dir, { allowedWrites: ["out"] }));
      try {
        if (linked) {
          assert.equal(existsSync(join(handle.jailRoot, "out", "link.txt")), false);
        }
        await handle.copyOut();
        if (linked) {
          assert.equal(lstatSync(join(dir, "out", "link.txt")).isSymbolicLink(), true);
          assert.equal(await readFile(outside, "utf8"), "host-secret\n");
        }
        assert.equal(await readFile(join(dir, "out", "keep.txt"), "utf8"), "keep\n");
      } finally {
        await handle.destroy();
      }
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("materializeJail refuses leftover jail path that is a symlink", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const leak = await mkdtemp(join(tmpdir(), "legion-jail-symlink-"));
    await writeFile(join(leak, "keep.txt"), "outside\n", "utf8");
    await mkdir(join(dir, ".legion-cli", "sandbox"), { recursive: true });
    const jailPath = join(dir, ".legion-cli", "sandbox", "run-1");
    const linked = await trySymlink(leak, jailPath, process.platform === "win32" ? "junction" : "dir");
    assert.equal(linked, true, "could not create leftover jail symlink");
    try {
      await assert.rejects(() => materializeJail(policy(dir)), PathEscapeError);
      assert.equal(await readFile(join(leak, "keep.txt"), "utf8"), "outside\n");
    } finally {
      await rm(jailPath, { force: true });
      await rm(leak, { recursive: true, force: true });
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

test("copy-out drops dest junction to leak dir and .git instead of following it", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const leak = await mkdtemp(join(tmpdir(), "legion-junc-leak-"));
    try {
      await rm(join(dir, "src"), { recursive: true, force: true });
      const linked = await trySymlink(leak, join(dir, "src"), process.platform === "win32" ? "junction" : "dir");
      assert.equal(linked, true, "could not create dest junction");
      const handle = await materializeJail(policy(dir));
      try {
        await mkdir(join(handle.jailRoot, "src"), { recursive: true });
        await writeFile(join(handle.jailRoot, "src", "main.ts"), "pwned-home\n", "utf8");
        const result = await handle.copyOut();
        assert.ok(result.dropped.includes("src/main.ts"));
        assert.ok(!result.copied.includes("src/main.ts"));
        assert.equal(existsSync(join(leak, "main.ts")), false);
      } finally {
        await handle.destroy();
      }
    } finally {
      await rm(join(dir, "src"), { recursive: true, force: true });
      await rm(leak, { recursive: true, force: true });
    }
  });

  await withTempDir(async (dir) => {
    await seedProject(dir);
    await rm(join(dir, "src"), { recursive: true, force: true });
    const linked = await trySymlink(join(dir, ".git"), join(dir, "src"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(linked, true, "could not create dest junction to .git");
    const handle = await materializeJail(policy(dir));
    try {
      await mkdir(join(handle.jailRoot, "src"), { recursive: true });
      await writeFile(join(handle.jailRoot, "src", "main.ts"), "pwned-git\n", "utf8");
      const result = await handle.copyOut();
      assert.ok(result.dropped.includes("src/main.ts"));
      assert.equal(existsSync(join(dir, ".git", "main.ts")), false);
      assert.equal(await readFile(join(dir, ".git", "hooks", "keep"), "utf8"), "keep\n");
    } finally {
      await handle.destroy();
    }
  });
});

test("copy-in refuses .git realpath and host symlink write-through", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const outside = join(tmpdir(), `legion-outside-${process.pid}-${Date.now()}.txt`);
    const leakDir = await mkdtemp(join(tmpdir(), "legion-host-junc-"));
    await writeFile(outside, "host-secret\n", "utf8");
    await writeFile(join(leakDir, "secret.txt"), "host-secret\n", "utf8");
    const juncType = process.platform === "win32" ? "junction" : "dir";
    try {
      const gitLink = await trySymlink(join(dir, ".git", "hooks", "keep"), join(dir, "src", "gitlink.ts"));
      const hostLink = await trySymlink(outside, join(dir, "src", "hostlink.ts"));
      const insideLink = await trySymlink(join(dir, "src", "read.ts"), join(dir, "src", "insidelink.ts"));
      const gitJunc = await trySymlink(join(dir, ".git"), join(dir, "src", "gitjunc"), juncType);
      const hostJunc = await trySymlink(leakDir, join(dir, "src", "hostjunc"), juncType);
      assert.equal(gitJunc, true, "could not create .git junction");
      assert.equal(hostJunc, true, "could not create host junction");
      if (process.platform !== "win32") {
        assert.equal(gitLink, true, "Linux CI must create gitlink file symlink");
        assert.equal(hostLink, true, "Linux CI must create hostlink file symlink");
      }
      const handle = await materializeJail(
        policy(dir, {
          readSet: ["src", "src/read.ts", "src/gitlink.ts", "src/hostlink.ts", "src/insidelink.ts", "src/gitjunc", "src/hostjunc"],
          allowedWrites: ["src/main.ts", "src/gitlink.ts", "src/hostlink.ts"],
        }),
      );
      try {
        assert.equal(existsSync(join(handle.jailRoot, "src", "gitlink.ts")), false);
        assert.equal(existsSync(join(handle.jailRoot, "src", "hostlink.ts")), false);
        assert.equal(existsSync(join(handle.jailRoot, "src", "gitjunc")), false);
        assert.equal(existsSync(join(handle.jailRoot, "src", "hostjunc")), false);
        if (insideLink) {
          const st = lstatSync(join(handle.jailRoot, "src", "insidelink.ts"));
          assert.equal(st.isSymbolicLink(), false);
          assert.equal(await readFile(join(handle.jailRoot, "src", "insidelink.ts"), "utf8"), "export const read = 1;\n");
        }
        if (gitLink) {
          await writeFile(join(handle.jailRoot, "src", "gitlink.ts"), "jail-git\n", "utf8");
        }
        if (hostLink) {
          await writeFile(join(handle.jailRoot, "src", "hostlink.ts"), "jail-host\n", "utf8");
        }
        const result = await handle.copyOut();
        if (gitLink) {
          assert.ok(result.dropped.includes("src/gitlink.ts"));
          assert.equal(lstatSync(join(dir, "src", "gitlink.ts")).isSymbolicLink(), true);
        }
        if (hostLink) {
          assert.ok(result.dropped.includes("src/hostlink.ts"));
          assert.equal(lstatSync(join(dir, "src", "hostlink.ts")).isSymbolicLink(), true);
        }
        assert.equal(await readFile(join(dir, ".git", "hooks", "keep"), "utf8"), "keep\n");
        assert.equal(await readFile(outside, "utf8"), "host-secret\n");
        assert.equal(await readFile(join(leakDir, "secret.txt"), "utf8"), "host-secret\n");
      } finally {
        await handle.destroy();
      }
    } finally {
      await rm(outside, { force: true });
      await rm(leakDir, { recursive: true, force: true });
    }
  });
});

test("HOME in spawn env is under .legion-cli/sandbox/", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(policy(dir));
    try {
      const env = handle.spawnOpts().env;
      assert.equal(env.HOME, join(handle.jailRoot, ".legion-cli", "sandbox-home"));
      assert.equal(handle.spawnOpts().cwd, handle.jailRoot);
      assert.equal(handle.jailRoot, join(dir, ".legion-cli", "sandbox", "run-1"));
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

test("Windows bwrap.cmd stub is not a hardened backend", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "bwrap.cmd"), "@echo off\r\necho stub\r\n", "utf8");
    await writeFile(join(dir, "bwrap.bat"), "@echo off\r\necho stub\r\n", "utf8");
    withPath(dir, () => {
      const detected = detectSandbox();
      assert.equal(detected.backend, "copy");
      assert.equal(detected.hardened, false);
    });
  });
});

test("bwrap that cannot set up a uid map is not a hardened backend", async () => {
  await withTempDir(async (dir) => {
    const script = [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      "  echo 'bwrap 0.9.0'",
      "  exit 0",
      "fi",
      "echo 'bwrap: setting up uid map: Permission denied' >&2",
      "exit 1",
      "",
    ].join("\n");
    await writeFile(join(dir, "bwrap"), script, { encoding: "utf8", mode: 0o755 });
    withPath(dir, () => {
      const detected = detectSandbox();
      assert.equal(detected.backend, "copy");
      assert.equal(detected.hardened, false);
    });
  });
});

test("sandbox env allowlist is exact jail paths; extras and SSH_AUTH_SOCK absent", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const prevSock = process.env.SSH_AUTH_SOCK;
    const prevKey = process.env.OPENAI_API_KEY;
    const prevLeak = process.env.LEGION_SANDBOX_LEAK;
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.LEGION_SANDBOX_LEAK = "nope";
    let handle;
    try {
      handle = await materializeJail(policy(dir, { credentialKeys: ["OPENAI_API_KEY"] }));
      const env = handle.spawnOpts().env;
      const home = join(handle.jailRoot, ".legion-cli", "sandbox-home");
      const tmp = join(handle.jailRoot, ".legion-cli", "sandbox-tmp");
      assert.equal(env.HOME, home);
      assert.equal(env.USERPROFILE, home);
      assert.equal(env.APPDATA, home);
      assert.equal(env.LOCALAPPDATA, home);
      assert.equal(env.TEMP, tmp);
      assert.equal(env.TMP, tmp);
      assert.equal(env.GIT_DIR, join(handle.jailRoot, ".git-null"));
      assert.equal(env.SSH_AUTH_SOCK, undefined);
      assert.equal(env.LEGION_SANDBOX_LEAK, undefined);
      assert.equal(env.OPENAI_API_KEY, "sk-test");
      for (const key of Object.keys(env)) {
        assert.ok(ENV_ALLOW.has(key), `unexpected env key ${key}`);
      }
    } finally {
      if (prevSock === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = prevSock;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      if (prevLeak === undefined) delete process.env.LEGION_SANDBOX_LEAK;
      else process.env.LEGION_SANDBOX_LEAK = prevLeak;
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

test("copy-in is sparse: no node_modules, nested node_modules, or operator .git", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await mkdir(join(dir, "src", "vendor", "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "src", "vendor", "node_modules", "x", "index.js"), "nope\n", "utf8");
    const handle = await materializeJail(policy(dir, { readSet: ["src/read.ts", "src"] }));
    try {
      assert.equal(existsSync(join(handle.jailRoot, "node_modules")), false);
      assert.equal(existsSync(join(handle.jailRoot, "src", "vendor", "node_modules")), false);
      assert.equal(existsSync(join(handle.jailRoot, ".git", "hooks", "keep")), false);
      assert.equal(await readFile(join(handle.jailRoot, "src", "read.ts"), "utf8"), "export const read = 1;\n");
    } finally {
      await handle.destroy();
    }
  });
});

test("copy-in copies one inode to every dest name", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await mkdir(join(dir, "src", "orig"), { recursive: true });
    await writeFile(join(dir, "src", "orig", "file.ts"), "shared\n", "utf8");
    const linked = await trySymlink(
      join(dir, "src", "orig"),
      join(dir, "src", "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(linked, true, "could not create alias junction");
    const handle = await materializeJail(policy(dir, { readSet: ["src"] }));
    try {
      assert.equal(await readFile(join(handle.jailRoot, "src", "orig", "file.ts"), "utf8"), "shared\n");
      assert.equal(await readFile(join(handle.jailRoot, "src", "alias", "file.ts"), "utf8"), "shared\n");
      const origFile = lstatSync(join(handle.jailRoot, "src", "orig", "file.ts"));
      const aliasFile = lstatSync(join(handle.jailRoot, "src", "alias", "file.ts"));
      assert.equal(origFile.isFile(), true);
      assert.equal(origFile.isSymbolicLink(), false);
      assert.equal(aliasFile.isFile(), true);
      assert.equal(aliasFile.isSymbolicLink(), false);
    } finally {
      await handle.destroy();
    }
  });
});

test("ancestor-cycle junction does not nest loop/loop", { timeout: 5000 }, async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const linked = await trySymlink(
      join(dir, "src"),
      join(dir, "src", "loop"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(linked, true, "could not create ancestor-cycle junction");
    const handle = await materializeJail(policy(dir, { readSet: ["src"] }));
    try {
      assert.equal(await readFile(join(handle.jailRoot, "src", "read.ts"), "utf8"), "export const read = 1;\n");
      assert.throws(
        () => lstatSync(join(handle.jailRoot, "src", "loop")),
        (err) => err && err.code === "ENOENT",
      );
      assert.throws(
        () => lstatSync(join(handle.jailRoot, "src", "loop", "loop")),
        (err) => err && err.code === "ENOENT",
      );
    } finally {
      await handle.destroy();
    }
  });
});

test(".GIT/hooks is refused and does not pollute operator .git", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await assert.rejects(
      () => materializeJail(policy(dir, { allowedWrites: [".GIT/hooks/evil"] })),
      PathEscapeError,
    );
    const handle = await materializeJail(policy(dir));
    try {
      await mkdir(join(handle.jailRoot, ".GIT", "hooks"), { recursive: true });
      await writeFile(join(handle.jailRoot, ".GIT", "hooks", "evil"), "evil\n", "utf8");
      const result = await handle.copyOut();
      assert.ok(
        result.dropped.some((rel) => rel.split("/").some((part) => part.toLowerCase() === ".git")),
        `expected .GIT drop, got dropped=${result.dropped.join(",")}`,
      );
      assert.equal(existsSync(join(dir, ".git", "hooks", "evil")), false);
      assert.equal(await readFile(join(dir, ".git", "hooks", "keep"), "utf8"), "keep\n");
    } finally {
      await handle.destroy();
    }
  });
});

test("dangling junction in readSet does not hang materializeJail", { timeout: 5000 }, async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const target = await mkdtemp(join(tmpdir(), "legion-dangle-"));
    const juncType = process.platform === "win32" ? "junction" : "dir";
    const linked = await trySymlink(target, join(dir, "src", "dangling"), juncType);
    assert.equal(linked, true, "could not create dangling junction");
    await rm(target, { recursive: true, force: true });
    const handle = await materializeJail(policy(dir, { readSet: ["src", "src/dangling"] }));
    try {
      assert.equal(existsSync(join(handle.jailRoot, "src", "read.ts")), true);
      assert.throws(
        () => lstatSync(join(handle.jailRoot, "src", "dangling")),
        (err) => err && err.code === "ENOENT",
      );
    } finally {
      await handle.destroy();
    }
  });
});

test("copy-out copies allowed writes when projectRoot is a symlink", async () => {
  await withTempDir(async (real) => {
    await seedProject(real);
    const holder = await mkdtemp(join(tmpdir(), "legion-rootlink-"));
    const link = join(holder, "proj");
    const linked = await trySymlink(real, link, process.platform === "win32" ? "junction" : "dir");
    assert.equal(linked, true, "could not create projectRoot symlink");
    try {
      const handle = await materializeJail(policy(link));
      try {
        await writeFile(join(handle.jailRoot, "src", "main.ts"), "via-link\n", "utf8");
        const result = await handle.copyOut();
        assert.ok(result.copied.includes("src/main.ts"), `copied=${result.copied.join(",")} dropped=${result.dropped.join(",")}`);
        assert.equal(await readFile(join(real, "src", "main.ts"), "utf8"), "via-link\n");
      } finally {
        await handle.destroy();
      }
    } finally {
      await rm(holder, { recursive: true, force: true });
    }
  });
});

test("destroy removes the jail directory", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(policy(dir));
    const jail = handle.jailRoot;
    assert.equal(existsSync(jail), true);
    await handle.destroy();
    assert.equal(existsSync(jail), false);
  });
});

test("policy paths refuse traversal, absolute, and backslash", async () => {
  await withTempDir(async (dir) => {
    const base = {
      projectRoot: dir,
      runId: "run-1",
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

test("bwrap wrapper omits unshare-net, binds hosts/nsswitch/passwd/group, sets HOME", async (t) => {
  const detected = detectSandbox();
  if (detected.backend !== "bwrap" || !detected.hardened) {
    t.skip(BWRAP_SKIP);
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
      const homeIdx = prefix.indexOf("--setenv");
      assert.ok(homeIdx >= 0);
      assert.equal(prefix[homeIdx + 1], "HOME");
      assert.equal(prefix[homeIdx + 2], join(handle.jailRoot, ".legion-cli", "sandbox-home"));
      assert.equal(prefix.at(-1), "--");
      assert.ok(opts.wrapper);
    } finally {
      await handle.destroy();
    }
  });
});

test("bwrap binds adapter file but not dirname $HOME or /", async (t) => {
  const detected = detectSandbox();
  if (detected.backend !== "bwrap" || !detected.hardened) {
    t.skip(BWRAP_SKIP);
    return;
  }
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const adapterDir = await mkdtemp(join(tmpdir(), "legion-adapter-"));
    const adapter = join(adapterDir, "adapter-bin");
    await writeFile(adapter, "#!/bin/sh\n", "utf8");
    const homeAdapter = join(homedir(), `legion-sandbox-adapter-${process.pid}`);
    await writeFile(homeAdapter, "#!/bin/sh\n", "utf8");
    try {
      const outside = await materializeJail(policy(dir, { adapterBinary: adapter }));
      try {
        const prefix = outside.spawnOpts().wrapper.argvPrefix;
        const dests = roBindDests(prefix);
        const adapterReal = realpathSync(adapter);
        assert.ok(
          dests.some((entry) => entry === adapterReal || entry === adapter),
          `expected adapter file bind, got ${dests.join(",")}`,
        );
        assert.equal(
          dests.some((entry) => entry === "/" || dirname(entry) === entry),
          false,
          `must not bind filesystem root, got ${dests.join(",")}`,
        );
      } finally {
        await outside.destroy();
      }

      const homeHandle = await materializeJail(policy(dir, { adapterBinary: homeAdapter }));
      try {
        const prefix = homeHandle.spawnOpts().wrapper.argvPrefix;
        const dests = roBindDests(prefix);
        const homeReal = realpathSync(homedir());
        assert.equal(
          dests.some((entry) => {
            try {
              return realpathSync(entry) === homeReal || entry === homeReal || entry === homedir();
            } catch {
              return entry === homeReal || entry === homedir();
            }
          }),
          false,
          `dirname $HOME must not be bound: ${dests.join(",")}`,
        );
        const adapterReal = realpathSync(homeAdapter);
        assert.ok(dests.some((entry) => entry === adapterReal || entry === homeAdapter));
      } finally {
        await homeHandle.destroy();
      }
    } finally {
      await rm(adapterDir, { recursive: true, force: true });
      await rm(homeAdapter, { force: true });
    }
  });
});

test("materializeJail throws when hardened backend cannot wrap adapter", async (t) => {
  const detected = detectSandbox();
  if (!detected.hardened) {
    t.skip(BWRAP_SKIP);
    return;
  }
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await assert.rejects(
      () => materializeJail(policy(dir, { adapterBinary: join(dir, "no-such-adapter") })),
      (err) => {
        assert.equal(err.name, "SandboxError");
        assert.equal(err.message, HARDENED_REQUIRED);
        return true;
      },
    );
    assert.equal(existsSync(join(dir, ".legion-cli", "sandbox", "run-1")), false);
  });
});

test("assertExecuteSandbox allows a hardened backend", (t) => {
  const detected = detectSandbox();
  if (!detected.hardened) {
    t.skip(BWRAP_SKIP);
    return;
  }
  assert.doesNotThrow(() => assertExecuteSandbox(makeConfig(), {}));
});

test("credentialKeys are adapter-scoped; other vendor keys are omitted", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const prevOpen = process.env.OPENAI_API_KEY;
    const prevGrok = process.env.GROK_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.GROK_API_KEY = "sk-grok";
    let handle;
    try {
      handle = await materializeJail(policy(dir, { credentialKeys: ["GROK_API_KEY"] }));
      const env = handle.spawnOpts().env;
      assert.equal(env.GROK_API_KEY, "sk-grok");
      assert.equal(env.OPENAI_API_KEY, undefined);
    } finally {
      if (prevOpen === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpen;
      if (prevGrok === undefined) delete process.env.GROK_API_KEY;
      else process.env.GROK_API_KEY = prevGrok;
      if (handle) await handle.destroy();
    }
  });
});

test("config backend copy uses copy even if LSM is available", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(policy(dir, { backend: "copy" }));
    try {
      assert.equal(handle.backend, "copy");
      assert.equal(handle.hardened, false);
      assert.equal(handle.spawnOpts().wrapper, undefined);
      const out = await handle.copyOut();
      assert.equal(out.dropped.includes("src/read.ts"), false);
    } finally {
      await handle.destroy();
    }
  });
});

test("allowDegradedCopy falls back to copy when adapter cannot be bound", async (t) => {
  const detected = detectSandbox();
  if (!detected.hardened) {
    t.skip(BWRAP_SKIP);
    return;
  }
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(
      policy(dir, { adapterBinary: join(dir, "no-such-adapter"), allowDegradedCopy: true }),
    );
    try {
      assert.equal(handle.backend, "copy");
      assert.equal(handle.hardened, false);
    } finally {
      await handle.destroy();
    }
  });
});

test("materializeJail refuses sandbox junction write-through", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const outside = await mkdtemp(join(tmpdir(), "legion-sandbox-junc-"));
    try {
      await mkdir(join(dir, ".legion-cli"), { recursive: true });
      const linked = await trySymlink(
        outside,
        join(dir, ".legion-cli", "sandbox"),
        process.platform === "win32" ? "junction" : "dir",
      );
      assert.equal(linked, true, "could not create sandbox junction");
      await assert.rejects(() => materializeJail(policy(dir)), PathEscapeError);
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("copy-out skips unchanged allowed files", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(policy(dir, { backend: "copy" }));
    try {
      await writeFile(join(dir, "src", "main.ts"), "operator edit\n", "utf8");
      const result = await handle.copyOut();
      assert.equal(result.copied.includes("src/main.ts"), false);
      assert.equal(await readFile(join(dir, "src", "main.ts"), "utf8"), "operator edit\n");
    } finally {
      await handle.destroy();
    }
  });
});

test("copy-out preserves repo home/ and tmp/ writes", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(join(dir, "home", "index.html"), "old\n", "utf8");
    const handle = await materializeJail(
      policy(dir, { allowedWrites: ["home/index.html", "tmp/result.json"], readSet: [] }),
    );
    try {
      await mkdir(join(handle.jailRoot, "home"), { recursive: true });
      await mkdir(join(handle.jailRoot, "tmp"), { recursive: true });
      await writeFile(join(handle.jailRoot, "home", "index.html"), "new-home\n", "utf8");
      await writeFile(join(handle.jailRoot, "tmp", "result.json"), "{\"ok\":true}\n", "utf8");
      const result = await handle.copyOut();
      assert.ok(result.copied.includes("home/index.html"));
      assert.ok(result.copied.includes("tmp/result.json"));
      assert.equal(await readFile(join(dir, "home", "index.html"), "utf8"), "new-home\n");
      assert.equal(await readFile(join(dir, "tmp", "result.json"), "utf8"), "{\"ok\":true}\n");
    } finally {
      await handle.destroy();
    }
  });
});

test("copy-out drops file-to-directory replacements instead of aborting", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const handle = await materializeJail(policy(dir, { allowedWrites: ["src/main.ts"] }));
    try {
      await rm(join(handle.jailRoot, "src", "main.ts"), { force: true });
      await mkdir(join(handle.jailRoot, "src", "main.ts"), { recursive: true });
      await writeFile(join(handle.jailRoot, "src", "main.ts", "generated"), "nope\n", "utf8");
      const result = await handle.copyOut();
      assert.ok(result.dropped.includes("src/main.ts/generated"));
      assert.equal(await readFile(join(dir, "src", "main.ts"), "utf8"), "export const main = 1;\n");
    } finally {
      await handle.destroy();
    }
  });
});

test("copy-out matches glob SkillContract write paths", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await mkdir(join(dir, ".legion-cli", "specs", "spec-a"), { recursive: true });
    await writeFile(join(dir, ".legion-cli", "specs", "spec-a", "prd.md"), "old\n", "utf8");
    const handle = await materializeJail(
      policy(dir, {
        allowedWrites: [".legion-cli/specs/*/prd.md"],
        readSet: [".legion-cli/specs/spec-a/prd.md"],
      }),
    );
    try {
      await writeFile(join(handle.jailRoot, ".legion-cli", "specs", "spec-a", "prd.md"), "new-prd\n", "utf8");
      const result = await handle.copyOut();
      assert.ok(result.copied.includes(".legion-cli/specs/spec-a/prd.md"));
      assert.equal(await readFile(join(dir, ".legion-cli", "specs", "spec-a", "prd.md"), "utf8"), "new-prd\n");
    } finally {
      await handle.destroy();
    }
  });
});

test("assertExecuteSandbox fails when config pins copy with requireHardened", () => {
  assert.throws(
    () => assertExecuteSandbox(makeConfig({ backend: "copy", requireHardened: true, allowCopyJail: false }), {}),
    (err) => {
      assert.equal(err.name, "SandboxError");
      assert.match(err.message, /hardened sandbox required/);
      return true;
    },
  );
});
