import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";

import { ASSUMED_EXTRA_BINARIES } from "@9thlevelsoftware/legion-cli-agents";
import { ADAPTER_CHOICES, preflightInit } from "../dist/init.js";
import { normalize, runCli, withTempDir } from "./helpers.js";

async function writeStubExecutable(dir, name) {
  await mkdir(dir, { recursive: true });
  if (process.platform === "win32") {
    const file = join(dir, `${name}.cmd`);
    await writeFile(file, "@echo off\r\nexit /b 0\r\n", "utf8");
    return file;
  }
  const file = join(dir, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(file, 0o755);
  return file;
}

test("ADAPTER_CHOICES excludes fake while --adapter fake remains accepted", async () => {
  assert.equal(ADAPTER_CHOICES.some((choice) => choice.id === "fake"), false);
  assert.ok(ADAPTER_CHOICES.some((choice) => choice.id === "openai"));
  assert.ok(ADAPTER_CHOICES.some((choice) => choice.id === "minimax"));

  await withTempDir(async (dir) => {
    const result = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.adapter, "fake");
    assert.equal(body.preflight.adapter.ready, true);
  });
});

test("preflightInit resolves extra adapter binaries via ASSUMED_EXTRA_BINARIES", async () => {
  await withTempDir(async (binDir) => {
    const prevPath = process.env.PATH;
    const prevWinPath = process.env.Path;
    try {
      // Isolated empty PATH first: verify assumed binary names appear when missing.
      process.env.PATH = binDir;
      if (process.platform === "win32") process.env.Path = binDir;

      for (const [adapterId, expectedBin] of Object.entries(ASSUMED_EXTRA_BINARIES)) {
        const missing = preflightInit(adapterId, undefined, undefined);
        assert.equal(missing.adapter.ready, false, `${adapterId} should not be ready without ${expectedBin}`);
        assert.equal(missing.adapter.detail, `${expectedBin} is not on PATH`);
      }

      // Create shims ONLY for codex and mcode (never "openai" or "minimax").
      await writeStubExecutable(binDir, ASSUMED_EXTRA_BINARIES.openai);
      await writeStubExecutable(binDir, ASSUMED_EXTRA_BINARIES.minimax);

      const openaiReady = preflightInit("openai", undefined, undefined);
      assert.equal(openaiReady.adapter.ready, true);
      assert.equal(openaiReady.adapter.detail, "codex is on PATH");

      const minimaxReady = preflightInit("minimax", undefined, undefined);
      assert.equal(minimaxReady.adapter.ready, true);
      assert.equal(minimaxReady.adapter.detail, "mcode is on PATH");
    } finally {
      process.env.PATH = prevPath;
      if (process.platform === "win32") {
        if (prevWinPath === undefined) delete process.env.Path;
        else process.env.Path = prevWinPath;
      }
    }
  });
});

test("init --adapter openai/minimax --json probes codex/mcode on PATH via CLI", async () => {
  await withTempDir(async (dir) => {
    const binDir = join(dir, "bin");
    await writeStubExecutable(binDir, "codex");
    await writeStubExecutable(binDir, "mcode");
    const envPath = [binDir, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
    const pathEnv = process.platform === "win32" ? { PATH: envPath, Path: envPath } : { PATH: envPath };

    const openaiDir = join(dir, "openai-proj");
    await mkdir(openaiDir);
    const openaiRes = runCli(
      ["init", "--project", openaiDir, "--name", "OpenAiApp", "--adapter", "openai", "--json"],
      { env: pathEnv },
    );
    assert.equal(openaiRes.status, 0, normalize(openaiRes.stderr));
    const openaiJson = JSON.parse(openaiRes.stdout);
    assert.equal(openaiJson.preflight.adapter.ready, true);
    assert.equal(openaiJson.preflight.adapter.detail, "codex is on PATH");

    const minimaxDir = join(dir, "minimax-proj");
    await mkdir(minimaxDir);
    const minimaxRes = runCli(
      ["init", "--project", minimaxDir, "--name", "MiniMaxApp", "--adapter", "minimax", "--json"],
      { env: pathEnv },
    );
    assert.equal(minimaxRes.status, 0, normalize(minimaxRes.stderr));
    const minimaxJson = JSON.parse(minimaxRes.stdout);
    assert.equal(minimaxJson.preflight.adapter.ready, true);
    assert.equal(minimaxJson.preflight.adapter.detail, "mcode is on PATH");
  });
});
