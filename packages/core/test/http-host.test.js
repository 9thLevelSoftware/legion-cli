import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assembleGovernedMcpArguments, dispatchToolCall, MAX_RUN_COMMAND_BYTES, RUN_COMMAND_DENIED_BINS, toolsForJob } from "@9thlevelsoftware/legion-cli-http";
import { createHttpToolHost, engineSotRefuseReason, governedMcpConfigIdentity, governedMcpToolContractIdentity, httpAllowedWrites } from "../dist/index.js";
import { materializeJail } from "@9thlevelsoftware/legion-cli-sandbox";

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

async function waitForJson(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function pidIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    throw err;
  }
}

function hostFor(jailRoot, extra = {}) {
  return createHttpToolHost({
    jailRoot,
    allowedWrites: extra.allowedWrites ?? ["src/x"],
    filesForbidden: extra.filesForbidden,
    hardened: extra.hardened ?? false,
    commandAllowlist: extra.commandAllowlist,
    commandPrefixes: extra.commandPrefixes,
    spawnOpts: extra.spawnOpts ?? { cwd: jailRoot, env: process.env },
  });
}

test("governed MCP resume identities bind transport and exact tool schema without credential values", () => {
  const stdio = (token, args = ["serve"]) => ({
    mcpHttpToolAllowlist: ["fixture:read"],
    mcpServers: {
      fixture: { transport: "stdio", command: "fixture-mcp", args, env: { FIXTURE_TOKEN: token } },
    },
  });
  assert.equal(
    governedMcpConfigIdentity(stdio("secret-one")),
    governedMcpConfigIdentity(stdio("secret-two")),
    "credential values are excluded",
  );
  assert.notEqual(governedMcpConfigIdentity(stdio("secret", ["serve"])), governedMcpConfigIdentity(stdio("secret", ["other"])));

  const remote = (url) => ({
    mcpHttpToolAllowlist: ["fixture:read"],
    mcpServers: {
      fixture: { transport: "streamable-http", url, authTokenEnv: "FIXTURE_TOKEN", allowLoopback: false },
    },
  });
  assert.notEqual(
    governedMcpConfigIdentity(remote("https://one.example/mcp")),
    governedMcpConfigIdentity(remote("https://two.example/mcp")),
  );

  const tool = { name: "fixture:read", inputSchema: { type: "object", required: ["path"] }, readOnly: true };
  assert.notEqual(
    governedMcpToolContractIdentity([tool]),
    governedMcpToolContractIdentity([{ ...tool, inputSchema: { type: "object", required: ["key"] } }]),
  );
  assert.notEqual(
    governedMcpToolContractIdentity([tool]),
    governedMcpToolContractIdentity([{ ...tool, readOnly: false }]),
  );
});
test("governed MCP arguments start from the fixed authority and place data only at declared schema pointers", () => {
  const inputSchema = {
    type: "object",
    properties: {
      account: { type: "string" },
      scope: { type: "object", properties: { tenant: { type: "string" }, label: { type: "string" } } },
      tags: { type: "array", items: { type: "string" } },
      filter: {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                levels: { type: "array", items: { type: "number" } },
              },
            },
          },
        },
      },
    },
    required: ["account"],
  };
  const authority = { account: "fixed-account", scope: { tenant: "fixed-tenant" }, tags: ["fixed"] };
  const encode = (pointer, value) => ({ pointer, content: new TextEncoder().encode(value) });
  const data = [
    ["/filter/groups/0/name", '"alpha"'],
    ["/filter/groups/0/levels/0", "2"],
    ["/filter/groups/0/levels/1", "4"],
    ["/filter/groups/1/name", '"beta"'],
    ["/filter/groups/1/levels/0", "7"],
    ["/scope/label", '"data label"'],
  ].map(([pointer, value]) => encode(pointer, value));
  assert.deepEqual(assembleGovernedMcpArguments(inputSchema, authority, data), {
    account: "fixed-account",
    scope: { tenant: "fixed-tenant", label: "data label" },
    tags: ["fixed"],
    filter: {
      groups: [
        { name: "alpha", levels: [2, 4] },
        { name: "beta", levels: [7] },
      ],
    },
  });
  assert.deepEqual(authority, { account: "fixed-account", scope: { tenant: "fixed-tenant" }, tags: ["fixed"] });
  for (const pointer of ["/account", "/scope", "/scope/tenant", "/tags/0", "/tags/1"]) {
    assert.throws(() => assembleGovernedMcpArguments(inputSchema, authority, [encode(pointer, '"injected"')]), /overlaps fixed authority/, pointer);
  }
  assert.throws(
    () => assembleGovernedMcpArguments(inputSchema, {}, [encode("/filter/groups/1/name", '"sparse"')]),
    /sparse MCP array pointer/,
  );
  assert.throws(
    () => assembleGovernedMcpArguments(inputSchema, {}, [encode("/filter/groups/0/name", '"alpha"')]),
    /do not satisfy the tool input schema/,
  );
  assert.throws(
    () => assembleGovernedMcpArguments(inputSchema, authority, [encode("/scope/label", "42")]),
    /do not satisfy the tool input schema/,
  );
});


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

test("governed host command allowlist is exact and defaults to the existing policy when omitted", async () => {
  await withTemp(async (dir) => {
    const scoped = hostFor(dir, {
      hardened: true,
      commandAllowlist: ["pnpm"],
      spawnOpts: { cwd: dir, env: process.env, wrapper: { bin: process.execPath, argvPrefix: [] } },
    });
    const denied = await scoped.runCommand([process.execPath, "script.js"]);
    assert.equal(denied.exitCode, 1);
    assert.match(denied.stderr, /job command allowlist/);

    const existing = hostFor(dir, {
      hardened: true,
      spawnOpts: { cwd: dir, env: process.env, wrapper: { bin: process.execPath, argvPrefix: [] } },
    });
    const policyDenied = await existing.runCommand(["git", "status"]);
    assert.match(policyDenied.stderr, /not allowlisted/);
  });
});

test("governed host requires the complete granted command prefix", async () => {
  await withTemp(async (dir) => {
    const host = hostFor(dir, {
      hardened: true,
      commandPrefixes: [["npx", "axe"]],
      spawnOpts: { cwd: dir, env: process.env, wrapper: { bin: process.execPath, argvPrefix: [] } },
    });
    const denied = await host.runCommand(["npx", "unrelated"]);
    assert.equal(denied.exitCode, 1);
    assert.match(denied.stderr, /command prefix allowlist/);
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
    await assert.rejects(() => host.writeFile(".legion-cli/STATE.md", "forged\n"), /engine-SoT refused: \.legion-cli\/STATE\.md/);
    await assert.rejects(
      () => host.writeFile(".legion-cli/tasks/TSK-0001.md", "forged\n"),
      /engine-SoT refused: \.legion-cli\/tasks\/TSK-0001\.md/,
    );
    await host.writeFile("src/ok.ts", "ok\n");
    assert.equal(await readFile(join(dir, "src", "ok.ts"), "utf8"), "ok\n");
    assert.equal(await readFile(join(dir, ".legion-cli", "STATE.md"), "utf8").catch((err) => err.code), "ENOENT");
  });
});

test("dispatchToolCall write_file to engine-SoT returns the named refusal", async () => {
  await withTemp(async (dir) => {
    const host = hostFor(dir, {
      allowedWrites: [".legion-cli/STATE.md", ".legion-cli/tasks", "src/ok.ts"],
    });
    const state = await dispatchToolCall(
      {
        id: "c1",
        type: "function",
        function: { name: "write_file", arguments: JSON.stringify({ path: ".legion-cli/STATE.md", contents: "forged\n" }) },
      },
      host,
      "plan",
    );
    assert.match(state, /engine-SoT refused: \.legion-cli\/STATE\.md/);
    const task = await dispatchToolCall(
      {
        id: "c2",
        type: "function",
        function: {
          name: "write_file",
          arguments: JSON.stringify({ path: ".legion-cli/tasks/TSK-0001.md", contents: "forged\n" }),
        },
      },
      host,
      "plan",
    );
    assert.match(task, /engine-SoT refused: \.legion-cli\/tasks\/TSK-0001\.md/);
  });
});

test("httpAllowedWrites drops engine-SoT paths", () => {
  assert.deepEqual(
    httpAllowedWrites(["src/ok.ts", ".legion-cli/STATE.md", ".legion-cli/tasks", ".legion-cli/tasks/TSK-0001.md", ".legion-cli/plans"]),
    ["src/ok.ts", ".legion-cli/plans"],
  );
  assert.match(engineSotRefuseReason(".legion-cli/STATE.md") ?? "", /engine-SoT refused/);
  assert.match(engineSotRefuseReason(".legion-cli/tasks/TSK-0001.md") ?? "", /engine-SoT refused/);
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

test("copy-jail host from materializeJail offers no run_command", async () => {
  await withTemp(async (dir) => {
    const sandbox = await materializeJail({
      projectRoot: dir,
      runId: "http-copy",
      allowedWrites: ["src/ok.ts"],
      readSet: [],
      backend: "copy",
      allowDegradedCopy: true,
    });
    try {
      assert.equal(sandbox.backend, "copy");
      assert.equal(sandbox.hardened, false);
      const spawnOpts = sandbox.spawnOpts();
      assert.equal(spawnOpts.wrapper, undefined);
      const host = createHttpToolHost({
        jailRoot: sandbox.jailRoot,
        allowedWrites: ["src/ok.ts"],
        hardened: sandbox.hardened,
        spawnOpts,
      });
      assert.equal(host.runCommand, undefined);
      assert.equal(
        toolsForJob("execute", host).some((tool) => tool.function.name === "run_command"),
        false,
      );
    } finally {
      await sandbox.destroy();
    }
  });
});

test("http host run_command refuses clustered node -pe", async () => {
  await withTemp(async (dir) => {
    const host = hostFor(dir, {
      hardened: true,
      spawnOpts: { cwd: dir, env: process.env, wrapper: { bin: process.execPath, argvPrefix: [] } },
    });
    const result = await host.runCommand([process.execPath, "-pe", "1"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /not allowlisted/);
  });
});

test("http host run_command refuses node -e", async () => {
  await withTemp(async (dir) => {
    const host = hostFor(dir, {
      hardened: true,
      spawnOpts: { cwd: dir, env: process.env, wrapper: { bin: process.execPath, argvPrefix: [] } },
    });
    const result = await host.runCommand([process.execPath, "-e", "process.exit(0)"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /not allowlisted/);
  });
});

for (const bin of RUN_COMMAND_DENIED_BINS) {
  test(`http host run_command refuses ${bin}`, async () => {
    await withTemp(async (dir) => {
      const host = hostFor(dir, {
        hardened: true,
        spawnOpts: { cwd: dir, env: process.env, wrapper: { bin: process.execPath, argvPrefix: [] } },
      });
      const result = await host.runCommand([bin]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /not allowlisted/);
    });
  });
}

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

test("run_command cancellation kills the wrapper process tree and rejects as aborted", { timeout: 10_000 }, async () => {
  await withTemp(async (dir) => {
    const pidsPath = join(dir, "command-pids.json");
    const grandchildScript = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
    const wrapperScript = [
      'const { spawn } = require("node:child_process")',
      'const { writeFileSync } = require("node:fs")',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" })`,
      `writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({ parent: process.pid, child: child.pid }))`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const host = hostFor(dir, {
      hardened: true,
      spawnOpts: {
        cwd: dir,
        env: process.env,
        wrapper: { bin: process.execPath, argvPrefix: ["-e", wrapperScript] },
      },
    });
    const controller = new AbortController();
    const running = host.runCommand([process.execPath], controller.signal);
    const pids = await waitForJson(pidsPath);
    assert.equal(pidIsLive(pids.parent), true);
    assert.equal(pidIsLive(pids.child), true);

    controller.abort();
    await assert.rejects(running, { name: "AbortError" });
    for (let attempt = 0; attempt < 100 && (pidIsLive(pids.parent) || pidIsLive(pids.child)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(pidIsLive(pids.parent), false);
    assert.equal(pidIsLive(pids.child), false);
  });
});
