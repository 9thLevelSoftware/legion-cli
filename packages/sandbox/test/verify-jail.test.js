import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  detectSandbox,
  prepareVerificationWrapper,
  verificationBwrapArgvPrefix,
  verificationSeatbeltProfile,
} from "../dist/index.js";

async function projectWithGitAndLegion() {
  const dir = await mkdtemp(join(tmpdir(), "legion-verify-jail-"));
  await mkdir(join(dir, ".git", "hooks"), { recursive: true });
  await mkdir(join(dir, ".legion-cli"), { recursive: true });
  return dir;
}

test("verify bwrap argv re-binds .git and .legion-cli read-only after the project bind", async () => {
  const dir = await projectWithGitAndLegion();
  try {
    const argv = verificationBwrapArgvPrefix(dir);
    const bindAt = argv.findIndex((arg, i) => arg === "--bind" && argv[i + 1] === argv[i + 2]);
    assert.ok(bindAt >= 0, "project --bind present");
    for (const rel of [".git", ".legion-cli"]) {
      const roAt = argv.findIndex((arg, i) => arg === "--ro-bind" && String(argv[i + 1]).endsWith(rel));
      assert.ok(roAt > bindAt, `${rel} --ro-bind must come after the writable project bind`);
      assert.equal(argv[roAt + 1], argv[roAt + 2]);
    }
    assert.equal(argv.at(-1), "--");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify bwrap argv only binds sensitive paths that exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-verify-jail-"));
  try {
    const argv = verificationBwrapArgvPrefix(dir);
    assert.ok(!argv.some((arg) => String(arg).endsWith(".git")), "no .git, no bind");
    assert.ok(!argv.some((arg) => String(arg).endsWith(".legion-cli")), "no .legion-cli, no bind");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify seatbelt profile denies writes to .git and .legion-cli after the project write allow", async () => {
  const dir = await projectWithGitAndLegion();
  try {
    const profile = verificationSeatbeltProfile(dir);
    const lines = profile.split("\n");
    const allowWrite = lines.findIndex((line) => line.startsWith("(allow file-write*"));
    const denyWrite = lines.findIndex((line) => line.startsWith("(deny file-write*"));
    assert.ok(allowWrite >= 0 && denyWrite > allowWrite, "deny must follow allow (last match wins)");
    assert.match(lines[denyWrite], /\.git/);
    assert.match(lines[denyWrite], /\.legion-cli/);
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
    assert.equal(existsSync(join(dir, ".git", "hooks", "pre-commit")), false);
    const state = spawnSync(
      wrapper.bin,
      [...wrapper.argvPrefix, process.execPath, "-e", "require('fs').writeFileSync('.legion-cli/STATE.md','x')"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.notEqual(state.status, 0, "write to .legion-cli must fail inside the verify jail");
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
