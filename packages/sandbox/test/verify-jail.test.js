import { createServer } from "node:net";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  DOCKER_WORKDIR,
  dockerArgvPrefix,
  detectSandbox,
  prepareVerificationWrapper,
  verificationBwrapArgvPrefix,
  verificationReadOnlyRels,
  verificationSeatbeltProfile,
} from "../dist/index.js";

async function projectWithGitAndLegion() {
  const dir = await mkdtemp(join(tmpdir(), "legion-verify-jail-"));
  await mkdir(join(dir, ".git", "hooks"), { recursive: true });
  await mkdir(join(dir, ".legion-cli"), { recursive: true });
  return dir;
}

test("verify bwrap argv re-binds sensitive dirs read-only, by exact path, after the project bind", async () => {
  const dir = await projectWithGitAndLegion();
  try {
    await mkdir(join(dir, ".husky"));
    await writeFile(join(dir, ".gitignore"), "x\n");
    const root = resolve(dir);
    const argv = verificationBwrapArgvPrefix(dir);
    const bindAt = argv.findIndex((arg, i) => arg === "--bind" && argv[i + 1] === root && argv[i + 2] === root);
    assert.ok(bindAt >= 0, "project --bind present");
    const ro = [];
    argv.forEach((arg, i) => {
      if (arg === "--ro-bind" && argv[i + 1] === argv[i + 2] && String(argv[i + 1]).startsWith(root)) ro.push([i, argv[i + 1]]);
    });
    assert.deepEqual(
      ro.map(([, path]) => path),
      [join(root, ".git"), join(root, ".legion-cli"), join(root, ".husky")],
      ".gitignore and absent .githooks must not be bound",
    );
    assert.ok(ro.every(([i]) => i > bindAt), "read-only binds come after the writable project bind");
    assert.equal(argv.at(-1), "--");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify bwrap argv only binds sensitive paths that exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-verify-jail-"));
  try {
    assert.deepEqual(verificationReadOnlyRels(dir), []);
    const argv = verificationBwrapArgvPrefix(dir);
    assert.ok(!argv.some((arg) => String(arg).endsWith(".git") || String(arg).endsWith(".legion-cli")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify seatbelt profile denies writes to the exact sensitive subpaths after the project write allow", async () => {
  const dir = await projectWithGitAndLegion();
  try {
    const root = resolve(dir);
    const lines = verificationSeatbeltProfile(dir).split("\n");
    const allowWrite = lines.findIndex((line) => line.startsWith("(allow file-write*"));
    const denyWrite = lines.findIndex((line) => line.startsWith("(deny file-write*"));
    assert.ok(allowWrite >= 0 && denyWrite > allowWrite, "deny must follow allow (last match wins)");
    const q = (rel) => JSON.stringify(join(root, rel));
    assert.equal(
      lines[denyWrite],
      `(deny file-write* (subpath ${q(".git")}) (subpath ${q(".legion-cli")}) (subpath ${q(".husky")}) (subpath ${q(".githooks")}))`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("docker verify wrapper mounts sensitive dirs read-only over the project mount", async () => {
  const dir = await projectWithGitAndLegion();
  try {
    const argv = dockerArgvPrefix({ jailRoot: dir, readOnlyRels: verificationReadOnlyRels(dir) });
    const mounts = argv.filter((arg, i) => argv[i - 1] === "-v");
    assert.deepEqual(mounts, [
      `${dir}:${DOCKER_WORKDIR}:rw`,
      `${join(dir, ".git")}:${DOCKER_WORKDIR}/.git:ro`,
      `${join(dir, ".legion-cli")}:${DOCKER_WORKDIR}/.legion-cli:ro`,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("information-flow wrapper arguments deny network and hide protected engine paths", async () => {
  const dir = await projectWithGitAndLegion();
  const engineDir = join(dir, "installed-engine");
  try {
    await mkdir(engineDir);
    const informationFlow = { informationFlow: { installedEnginePaths: [engineDir] } };
    const bwrap = verificationBwrapArgvPrefix(dir, informationFlow);
    assert.ok(bwrap.includes("--unshare-net"));
    assert.ok(bwrap.includes("--tmpfs"));
    assert.ok(bwrap.includes(join(dir, ".legion-cli")));
    assert.ok(bwrap.includes(engineDir));
    const seatbelt = verificationSeatbeltProfile(dir, informationFlow);
    assert.ok(!seatbelt.includes("(allow network*)"));
    assert.match(seatbelt, /\(deny file-read\*.*\.legion-cli/);
    assert.match(seatbelt, /\(deny file-write\*.*installed-engine/);
    const docker = dockerArgvPrefix({ jailRoot: dir, hiddenRels: [".legion-cli", "installed-engine"] });
    assert.ok(docker.includes("--network") && docker[docker.indexOf("--network") + 1] === "none");
    assert.ok(docker.includes(`${DOCKER_WORKDIR}/.legion-cli:rw,noexec,nosuid,size=16m`));
    assert.ok(docker.includes(`${DOCKER_WORKDIR}/installed-engine:rw,noexec,nosuid,size=16m`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("information-flow wrappers mount project-local engine closure read-only and ignore external roots", async () => {
  const dir = realpathSync(await projectWithGitAndLegion());
  const external = await mkdtemp(join(tmpdir(), "legion-verify-external-"));
  try {
    const modules = join(dir, "node_modules");
    const transitive = join(modules, ".pnpm", "dep@1.0.0", "node_modules", "dep");
    const hidden = join(modules, "hidden-engine");
    await mkdir(transitive, { recursive: true });
    await mkdir(hidden, { recursive: true });
    const options = {
      informationFlow: {
        installedEnginePaths: [hidden],
        readOnlyEnginePaths: [realpathSync(transitive), realpathSync(hidden), realpathSync(external)],
      },
    };
    const bwrap = verificationBwrapArgvPrefix(dir, options);
    const readOnly = bwrap.findIndex((arg, index) => arg === "--ro-bind" && bwrap[index + 1] === modules && bwrap[index + 2] === modules);
    assert.ok(readOnly >= 0, "project node_modules containing the closure is read-only");
    assert.ok(readOnly < bwrap.indexOf(hidden), "read-only mount precedes nested hidden engine paths");
    assert.equal(bwrap.includes(realpathSync(external)), false, "external closure roots are not mounted");
    const seatbelt = verificationSeatbeltProfile(dir, options);
    const denyWrite = seatbelt.split("\n").find((line) => line.startsWith("(deny file-write*"));
    assert.ok(denyWrite?.includes(JSON.stringify(realpathSync(modules))), "seatbelt denies writes to the closure mount");
    assert.equal(seatbelt.includes(JSON.stringify(realpathSync(external))), false);
    assert.throws(
      () => verificationBwrapArgvPrefix(dir, { informationFlow: { installedEnginePaths: [], readOnlyEnginePaths: [realpathSync(join(dir, ".."))] } }),
      /cannot contain the project root/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("legacy verification wrappers retain their existing networking policy", async () => {
  const dir = await projectWithGitAndLegion();
  try {
    assert.ok(!verificationBwrapArgvPrefix(dir).includes("--unshare-net"));
    assert.ok(verificationSeatbeltProfile(dir).includes("(allow network*)"));
    const docker = dockerArgvPrefix({ jailRoot: dir });
    assert.ok(docker.includes("--network") && docker[docker.indexOf("--network") + 1] === "none");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("information-flow verification refuses host and copy wrapper postures", async () => {
  const dir = await projectWithGitAndLegion();
  try {
    const options = { informationFlow: { installedEnginePaths: [] } };
    assert.equal(await prepareVerificationWrapper(dir, "flow-host", {
      tier: "allowlist",
      note: "test",
      backend: "host",
      copyJail: false,
    }, options), undefined);
    assert.equal(await prepareVerificationWrapper(dir, "flow-copy", {
      tier: "hardened-bwrap",
      note: "test",
      backend: "copy",
      copyJail: false,
    }, options), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Linux CI leg only (bwrap on ubuntu-latest). Cannot run on Windows/macOS hosts.
test("verify jail: a command that writes to .git/hooks fails and leaves no hook", async (t) => {
  const detected = detectSandbox();
  if (process.platform !== "linux" || detected.backend !== "bwrap" || !detected.hardened) {
    t.skip("bwrap not available (Linux CI leg only)");
    return;
  }
  const dir = await projectWithGitAndLegion();
  try {
    const wrapper = await prepareVerificationWrapper(dir, "verify-jail-test", {
      tier: "hardened-bwrap",
      note: "test",
      backend: "bwrap",
      copyJail: false,
    });
    assert.ok(wrapper, "bwrap wrapper");
    const script = "require('fs').writeFileSync('.git/hooks/pre-commit','#!/bin/sh\\n')";
    const bad = spawnSync(wrapper.bin, [...wrapper.argvPrefix, process.execPath, "-e", script], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.notEqual(bad.status, 0, "write to .git/hooks must fail inside the verify jail");
    assert.match(bad.stderr, /EROFS|read-only/i, "must fail because the mount is read-only");
    assert.equal(existsSync(join(dir, ".git", "hooks", "pre-commit")), false);
    const state = spawnSync(
      wrapper.bin,
      [...wrapper.argvPrefix, process.execPath, "-e", "require('fs').writeFileSync('.legion-cli/STATE.md','x')"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.notEqual(state.status, 0, "write to .legion-cli must fail inside the verify jail");
    assert.match(state.stderr, /EROFS|read-only/i, "must fail because the mount is read-only");
    assert.equal(existsSync(join(dir, ".legion-cli", "STATE.md")), false);
    const ok = spawnSync(
      wrapper.bin,
      [...wrapper.argvPrefix, process.execPath, "-e", "require('fs').writeFileSync('ok.txt','x')"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(await readFile(join(dir, "ok.txt"), "utf8"), "x");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Linux information-flow bwrap denies network and hides engine controls", async (t) => {
  const detected = detectSandbox();
  if (process.platform !== "linux" || detected.backend !== "bwrap" || !detected.hardened) {
    t.skip("bwrap isolation test is Linux-only");
    return;
  }
  const dir = await projectWithGitAndLegion();
  const installedEngineDir = join(dir, "node_modules", "installed-engine");
  await mkdir(installedEngineDir, { recursive: true });
  const installedEnginePath = join(installedEngineDir, "engine.js");
  await writeFile(installedEnginePath, "private-installed-engine");
  const server = createServer((socket) => socket.end("reachable"));
  try {
    await writeFile(join(dir, ".legion-cli", "authority"), "private-authority");
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const wrapper = await prepareVerificationWrapper(dir, "flow-network-test", {
      tier: "hardened-bwrap",
      note: "information-flow test",
      backend: "bwrap",
      copyJail: false,
    }, { informationFlow: { installedEnginePaths: [installedEngineDir] } });
    assert.ok(wrapper, "real hardened bwrap wrapper");
    const script = [
      "const fs=require('fs'), net=require('net');",
      `try { if(fs.readFileSync(${JSON.stringify(installedEnginePath)},'utf8')==='private-installed-engine') process.exit(14); } catch {}`,
      `const socket=net.connect(${address.port},'127.0.0.1');`,
      "socket.once('connect',()=>process.exit(12));",
      "socket.once('error',()=>process.exit(0));",
      "setTimeout(()=>process.exit(13),2500);",
    ].join("");
    const result = spawnSync(wrapper.bin, [...wrapper.argvPrefix, process.execPath, "-e", script], {
      cwd: dir,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
