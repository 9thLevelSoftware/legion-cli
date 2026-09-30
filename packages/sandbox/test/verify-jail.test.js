import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
