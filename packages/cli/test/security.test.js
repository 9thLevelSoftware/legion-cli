import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { normalize, runCli, withTempDir } from "./helpers.js";

async function writeLegionCliStub(dir) {
  const name = process.platform === "win32" ? "legion-cli.cmd" : "legion-cli";
  const body = process.platform === "win32" ? "@echo off\r\necho stub\r\n" : "#!/bin/sh\necho stub\n";
  const abs = join(dir, name);
  await writeFile(abs, body, "utf8");
  if (process.platform !== "win32") await chmod(abs, 0o755);
  return abs;
}

function pathEnvWith(dirs) {
  const current = process.env.PATH ?? process.env.Path ?? "";
  const value = [...dirs, current].join(delimiter);
  return process.platform === "win32" ? { PATH: value, Path: value } : { PATH: value };
}

test("doctor warns on multiple legion-cli binaries on PATH", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const a = await mkdtemp(join(tmpdir(), "legion-cli-a-"));
    const b = await mkdtemp(join(tmpdir(), "legion-cli-b-"));
    await writeLegionCliStub(a);
    await writeLegionCliStub(b);
    const result = runCli(["doctor", "--project", dir, "--json"], {
      env: {
        LEGION_CLI_ADAPTER: "fake",
        ...pathEnvWith([a, b]),
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.ok(Array.isArray(body.path["legion-cli"]));
    assert.ok(
      body.path["legion-cli"].length > 1,
      `expected colliding PATH entries, got ${JSON.stringify(body.path["legion-cli"])}`,
    );
    assert.ok(
      body.warnings.some((warning) => /multiple legion-cli binaries on PATH \(collision check\)/.test(warning)),
      `expected collision warning, got ${JSON.stringify(body.warnings)}`,
    );
  });
});

test("doctor fails spawnable when extra adapter args omit {{pointer}}", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "grok"]);
    assert.equal(init.status, 0, init.stderr);
    const configPath = join(dir, ".legion-cli", "config.yaml");
    const config = await readFile(configPath, "utf8");
    const patched = config.replace(
      /adapter:\r?\n  default: grok/,
      [
        "adapter:",
        "  default: grok",
        "  grok:",
        "    binary: node",
        "    args:",
        "      - -e",
        "      - console.log(1)",
      ].join("\n"),
    );
    assert.notEqual(patched, config, "expected to patch adapter.grok args");
    await writeFile(configPath, patched, "utf8");
    const result = runCli(["doctor", "--project", dir, "--json"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.equal(body.adapter.spawnable, false);
    assert.ok(
      body.warnings.some((warning) => /adapter\.grok\.args must include \{\{pointer\}\}/.test(warning)),
      `expected pointer warning, got ${JSON.stringify(body.warnings)}`,
    );
  });
});

test("doctor scans wiki for leftover secret patterns", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await mkdir(join(dir, ".legion-cli", "wiki", "ingested"), { recursive: true });
    await writeFile(
      join(dir, ".legion-cli", "wiki", "ingested", "leaked.md"),
      "---\nschemaVersion: legion-cli-wiki-page/v1\ntitle: Leaked\ntrust: untrusted\n---\n\nAKIAIOSFODNN7EXAMPLE\n",
      "utf8",
    );
    const result = runCli(["doctor", "--project", dir, "--json"], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const body = JSON.parse(result.stdout);
    assert.ok(
      body.warnings.some((warning) => /wiki secret scan:/.test(warning)),
      `expected secret-scan warning, got ${JSON.stringify(body.warnings)}`,
    );
    assert.ok(body.secrets.some((hit) => hit.name === "aws-access-key"));
    const text = runCli(["doctor", "--project", dir], {
      env: { LEGION_CLI_ADAPTER: "fake" },
    });
    assert.match(normalize(text.stdout), /Secrets\s+1 hit/);
  });
});
