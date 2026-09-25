import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_RUN_COMMAND_BYTES, toolsForJob } from "@9thlevelsoftware/legion-cli-http";
import { createHttpToolHost } from "../dist/http-host.js";

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-http-host-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function trySymlink(target, path, type) {
  try {
    await symlink(target, path, type);
    return true;
  } catch {
    return false;
  }
}

function hostFor(jailRoot, extra = {}) {
  return createHttpToolHost({
    jailRoot,
    allowedWrites: extra.allowedWrites ?? ["src/x"],
    filesForbidden: extra.filesForbidden,
    hardened: extra.hardened ?? false,
    spawnOpts: extra.spawnOpts ?? { cwd: jailRoot, env: process.env },
  });
}

test("read_file and write_file refuse .env and .ENV", async () => {
  await withTemp(async (dir) => {
    const host = hostFor(dir, { allowedWrites: [".env", ".ENV", "src/ok.ts"] });
    await assert.rejects(() => host.readFile(".env"), /implicit forbidden/);
    await assert.rejects(() => host.readFile(".ENV"), /implicit forbidden/);
    await assert.rejects(() => host.writeFile(".env", "SECRET=1\n"), /implicit forbidden/);
    await assert.rejects(() => host.writeFile(".ENV", "SECRET=1\n"), /implicit forbidden/);
    await host.writeFile("src/ok.ts", "ok\n");
    assert.equal(await readFile(join(dir, "src", "ok.ts"), "utf8"), "ok\n");
  });
});

test("symlink allowedWrites/x → .env is not read or written through", async () => {
  await withTemp(async (dir) => {
    await writeFile(join(dir, ".env"), "SECRET=1\n", "utf8");
    await mkdir(join(dir, "src"), { recursive: true });
    const linked = await trySymlink(join(dir, ".env"), join(dir, "src", "x"), "file");
    if (!linked) {
      await rm(join(dir, "src"), { recursive: true, force: true });
      const leak = await mkdtemp(join(tmpdir(), "legion-env-leak-"));
      await writeFile(join(leak, "x"), "SECRET=1\n", "utf8");
      const junc = await trySymlink(leak, join(dir, "src"), process.platform === "win32" ? "junction" : "dir");
      assert.equal(junc, true, "could not create file symlink or dir junction");
    }
    const host = hostFor(dir, { allowedWrites: ["src/x"] });
    await assert.rejects(() => host.readFile("src/x"), /symlink refused/);
    await assert.rejects(() => host.writeFile("src/x", "pwned\n"), /symlink refused/);
    assert.equal(await readFile(join(dir, ".env"), "utf8"), "SECRET=1\n");
  });
});

test("write_file refuses engine-SoT STATE.md and tasks/** even when listed in allowedWrites", async () => {
  await withTemp(async (dir) => {
    const host = hostFor(dir, {
      allowedWrites: [".legion-cli/STATE.md", ".legion-cli/tasks", "src/ok.ts"],
    });
    await assert.rejects(() => host.writeFile(".legion-cli/STATE.md", "forged\n"), /implicit forbidden/);
    await assert.rejects(() => host.writeFile(".legion-cli/tasks/TSK-0001.md", "forged\n"), /implicit forbidden/);
    await host.writeFile("src/ok.ts", "ok\n");
    assert.equal(await readFile(join(dir, "src", "ok.ts"), "utf8"), "ok\n");
  });
});

test("run_command is on the tool list only when the host is hardened", () => {
  const copy = hostFor("/tmp/jail", { hardened: false });
  assert.equal(copy.runCommand, undefined);
  assert.deepEqual(
    toolsForJob("execute", copy).map((tool) => tool.function.name),
    ["read_file", "write_file", "list_dir"],
  );
  const hardened = hostFor("/tmp/jail", {
    hardened: true,
    spawnOpts: { cwd: "/tmp/jail", env: process.env, wrapper: { bin: "bwrap", argvPrefix: ["--"] } },
  });
  assert.equal(typeof hardened.runCommand, "function");
  assert.deepEqual(
    toolsForJob("execute", hardened).map((tool) => tool.function.name),
    ["read_file", "write_file", "list_dir", "run_command"],
  );
});

test("run_command kills and truncates when stdout exceeds the cap", async () => {
  await withTemp(async (dir) => {
    const script = `process.stdout.write("x".repeat(${MAX_RUN_COMMAND_BYTES + 4096}))`;
    const host = hostFor(dir, {
      hardened: true,
      spawnOpts: {
        cwd: dir,
        env: process.env,
        wrapper: { bin: process.execPath, argvPrefix: ["-e", script] },
      },
    });
    const result = await host.runCommand([process.execPath]);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stdout.length <= MAX_RUN_COMMAND_BYTES);
    assert.match(result.stderr, /exceeded/);
  });
});
