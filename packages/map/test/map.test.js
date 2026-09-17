import assert from "node:assert/strict";
import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  GENERATED_END,
  GENERATED_START,
  MapError,
  fingerprintHash,
  generateMap,
  lspSpawnEnv,
  parseSource,
} from "../dist/index.js";
import {
  THREE_TS,
  spawnMockLsp,
  spawnMockLspHangAfter,
  spawnMockLspWithLog,
  withTempDir,
  writeManyTs,
  writeTree,
} from "./helpers.js";

function moduleOf(result, path) {
  return result.fingerprints.modules.find((row) => row.path === path);
}

const lspRequire = {
  lsp: "require",
  resolveBinary: (name) => (name === "typescript-language-server" ? process.execPath : null),
  spawnLsp: spawnMockLsp,
};

test("fallback parser: three TS files, stable hash; comment-only does not churn; export add does", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    const first = await generateMap(dir);
    assert.equal(first.backend, "fallback");
    assert.equal(first.fingerprints.schemaVersion, "legion-cli-fingerprint/v1");
    assert.equal(first.fingerprints.modules.length, 3);
    assert.deepEqual(first.changed, ["src/auth.ts", "src/db.ts", "src/index.ts"]);

    const auth = moduleOf(first, "src/auth.ts");
    assert.ok(auth);
    assert.deepEqual(auth.exports, ["login", "logout"]);
    assert.deepEqual(auth.imports, ["./db.js"]);
    assert.equal(auth.hash, fingerprintHash("src/auth.ts", ["login", "logout"], ["./db.js"]));
    assert.match(auth.hash, /^[a-f0-9]{64}$/);

    const db = moduleOf(first, "src/db.ts");
    assert.deepEqual(db.exports, ["connect", "url"]);
    const index = moduleOf(first, "src/index.ts");
    assert.deepEqual(index.exports, ["main"]);
    assert.deepEqual(index.imports, ["./auth.js"]);

    const second = await generateMap(dir);
    assert.equal(second.fingerprints.rootHash, first.fingerprints.rootHash);
    assert.equal(moduleOf(second, "src/auth.ts").hash, auth.hash);
    assert.deepEqual(second.changed, []);
    assert.equal(second.fingerprints.generatedAt, first.fingerprints.generatedAt);

    await writeFile(join(dir, "src", "auth.ts"), `${THREE_TS["src/auth.ts"]}\n// comment only\n`, "utf8");
    const commented = await generateMap(dir);
    assert.equal(moduleOf(commented, "src/auth.ts").hash, auth.hash);
    assert.equal(commented.fingerprints.rootHash, first.fingerprints.rootHash);
    assert.deepEqual(commented.changed, []);

    await writeFile(
      join(dir, "src", "auth.ts"),
      `${THREE_TS["src/auth.ts"]}\nexport function refresh() {}\n`,
      "utf8",
    );
    const added = await generateMap(dir);
    const addedAuth = moduleOf(added, "src/auth.ts");
    assert.deepEqual(addedAuth.exports, ["login", "logout", "refresh"]);
    assert.notEqual(addedAuth.hash, auth.hash);
    assert.notEqual(added.fingerprints.rootHash, first.fingerprints.rootHash);
    assert.deepEqual(added.changed, ["src/auth.ts"]);
  });
});

test("--refresh preserves prose outside generated markers", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    const first = await generateMap(dir);
    const original = await readFile(first.architecturePath, "utf8");
    assert.match(original, new RegExp(GENERATED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(original, /backend: fallback/);
    assert.match(original, /Human prose below this line is preserved across --refresh/);

    const annotated = `BEFORE_MARKER\n${original.replace(
      "Human prose below this line is preserved across --refresh.",
      "HUMAN_PROSE_TOKEN keep",
    )}`;
    await writeFile(first.architecturePath, annotated, "utf8");
    await writeFile(
      join(dir, "src", "auth.ts"),
      `${THREE_TS["src/auth.ts"]}\nexport function refresh() {}\n`,
      "utf8",
    );

    const second = await generateMap(dir, { refresh: true });
    const after = await readFile(second.architecturePath, "utf8");
    assert.match(after, /BEFORE_MARKER/);
    assert.match(after, /HUMAN_PROSE_TOKEN keep/);
    assert.match(after, /refresh/);
    assert.match(after, new RegExp(GENERATED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(after, new RegExp(GENERATED_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const generated = after.slice(after.indexOf(GENERATED_START), after.indexOf(GENERATED_END));
    assert.equal(generated.includes("HUMAN_PROSE_TOKEN"), false);
    assert.equal(generated.includes("BEFORE_MARKER"), false);
  });
});

test("unchanged hashes still recreate a missing ARCHITECTURE.md", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    const first = await generateMap(dir);
    await unlink(first.architecturePath);
    const second = await generateMap(dir);
    assert.equal(second.fingerprints.generatedAt, first.fingerprints.generatedAt);
    assert.deepEqual(second.changed, []);
    const body = await readFile(second.architecturePath, "utf8");
    assert.match(body, /backend: fallback/);
    assert.match(body, /src\/auth\.ts/);
  });
});

test("default map with typescript-language-server on PATH still uses fallback (no LSP traffic)", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    let spawned = 0;
    const result = await generateMap(dir, {
      resolveBinary: (name) => (name === "typescript-language-server" ? "/fake/typescript-language-server" : null),
      spawnLsp: () => {
        spawned += 1;
        throw new Error("default map must not spawn LSP");
      },
    });
    assert.equal(spawned, 0);
    assert.equal(result.backend, "fallback");
    assert.deepEqual(moduleOf(result, "src/auth.ts").exports, ["login", "logout"]);
  });
});

test("--lsp mock server: two depth-0 Function symbols become exports; hash stable; stderr flood does not deadlock", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    const first = await generateMap(dir, lspRequire);
    assert.equal(first.backend, "lsp");
    const auth = moduleOf(first, "src/auth.ts");
    assert.deepEqual(auth.exports, ["alpha", "beta"]);
    assert.equal(auth.exports.includes("nested"), false);
    assert.deepEqual(auth.imports, ["./db.js"]);
    assert.equal(auth.hash, fingerprintHash("src/auth.ts", ["alpha", "beta"], ["./db.js"]));

    const second = await generateMap(dir, lspRequire);
    assert.equal(second.backend, "lsp");
    assert.equal(moduleOf(second, "src/auth.ts").hash, auth.hash);
    assert.equal(second.fingerprints.rootHash, first.fingerprints.rootHash);
  });
});

test("walk skips node_modules and .legion-cli at repo root, not only src test globs", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, {
      ...THREE_TS,
      ".legion-cli/map/leaked.ts": "export function leaked() {}\n",
      "node_modules/pkg/index.ts": "export function nm() {}\n",
      "src/node_modules/hidden.ts": "export function nestedNm() {}\n",
      "src/auth.test.ts": "export function testOnly() {}\n",
      "src/auth.spec.ts": "export function specOnly() {}\n",
    });
    const result = await generateMap(dir, { roots: [] });
    const paths = result.fingerprints.modules.map((row) => row.path).sort();
    assert.deepEqual(paths, ["src/auth.ts", "src/db.ts", "src/index.ts"]);
    assert.equal(paths.includes(".legion-cli/map/leaked.ts"), false);
    assert.equal(paths.includes("node_modules/pkg/index.ts"), false);
    assert.equal(paths.includes("src/node_modules/hidden.ts"), false);
  });
});

test("win32 skips mixed-case .LEGION-CLI", { skip: process.platform !== "win32" }, async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, {
      ...THREE_TS,
      ".LEGION-CLI/map/leaked.ts": "export function leaked() {}\n",
    });
    const result = await generateMap(dir, { roots: [] });
    const paths = result.fingerprints.modules.map((row) => row.path);
    assert.equal(
      paths.some((path) => path.toLowerCase().includes(".legion-cli")),
      false,
    );
    assert.ok(paths.includes("src/auth.ts"));
  });
});

test("--lsp with no server throws so PR-04 can map Next: legion-cli map --no-lsp", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    await assert.rejects(
      () => generateMap(dir, { lsp: "require", resolveBinary: () => null }),
      (err) => {
        assert.equal(err instanceof MapError, true);
        assert.equal(err.nextHint, "legion-cli map --no-lsp");
        return true;
      },
    );
  });
});

test("walk roots reject .. (ConcretePosixPath)", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    await assert.rejects(
      () => generateMap(dir, { roots: ["../outside"] }),
      (err) => {
        assert.equal(err instanceof MapError, true);
        assert.equal(err.nextHint, "concrete paths");
        return true;
      },
    );
  });
});

test("parseSource covers python/go/rust fallback regexes", () => {
  const py = parseSource(
    "pkg/mod.py",
    "from os import path\nimport sys\ndef run():\n    pass\nclass App:\n    pass\n",
  );
  assert.equal(py.language, "py");
  assert.deepEqual(py.exports.sort(), ["App", "run"]);
  assert.deepEqual(py.imports.sort(), ["os", "sys"]);

  const go = parseSource("main.go", 'package main\nimport "fmt"\nfunc Hello() {}\ntype Box struct {}\n');
  assert.equal(go.language, "go");
  assert.deepEqual(go.exports.sort(), ["Box", "Hello"]);
  assert.deepEqual(go.imports, ["fmt"]);

  const rs = parseSource("lib.rs", "pub fn open() {}\npub struct Thing {}\nfn hidden() {}\n");
  assert.equal(rs.language, "rs");
  assert.deepEqual(rs.exports.sort(), ["Thing", "open"]);
  assert.deepEqual(rs.imports, []);
});

test("LSP spawn env drops SSH_AUTH_SOCK and API keys", () => {
  const env = lspSpawnEnv({
    PATH: "/bin",
    TERM: "xterm",
    SSH_AUTH_SOCK: "/tmp/ssh.sock",
    OPENAI_API_KEY: "sk-test",
    GOPATH: "/go",
  });
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.TERM, "xterm");
  assert.equal(env.GOPATH, "/go");
});

test("resolve .cmd path is passed through to spawn", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    const cmdPath = join(dir, "typescript-language-server.cmd");
    let spawned = "";
    const result = await generateMap(dir, {
      lsp: "require",
      resolveBinary: (name) => (name === "typescript-language-server" ? cmdPath : null),
      spawnLsp: (command, args, cwd) => {
        spawned = command;
        return spawnMockLsp(command, args, cwd);
      },
    });
    assert.equal(spawned, cmdPath);
    assert.equal(result.backend, "lsp");
  });
});

test("LSP timeout recomputes fallback consistently; next auto run does not churn hashes", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    const result = await generateMap(dir, {
      lsp: "require",
      resolveBinary: (name) => (name === "typescript-language-server" ? process.execPath : null),
      spawnLsp: spawnMockLspHangAfter(1),
      lspDeadlineMs: 1500,
    });
    assert.equal(result.backend, "fallback");
    assert.equal(result.fingerprints.modules.some((row) => row.exports.includes("alpha")), false);
    assert.deepEqual(moduleOf(result, "src/auth.ts").exports, ["login", "logout"]);

    const again = await generateMap(dir);
    assert.equal(again.backend, "fallback");
    assert.equal(again.fingerprints.rootHash, result.fingerprints.rootHash);
    assert.equal(again.fingerprints.generatedAt, result.fingerprints.generatedAt);
    assert.deepEqual(again.changed, []);
  });
});

test("auto reuses persisted backend lsp (spawn); throwing resolveBinary does not spawn", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    const first = await generateMap(dir, lspRequire);
    assert.equal(first.backend, "lsp");

    let spawns = 0;
    const reused = await generateMap(dir, {
      resolveBinary: (name) => (name === "typescript-language-server" ? process.execPath : null),
      spawnLsp: (command, args, cwd) => {
        spawns += 1;
        return spawnMockLsp(command, args, cwd);
      },
    });
    assert.ok(spawns > 0);
    assert.equal(reused.backend, "lsp");
    assert.equal(reused.fingerprints.rootHash, first.fingerprints.rootHash);
    assert.equal(reused.fingerprints.generatedAt, first.fingerprints.generatedAt);

    let spawnedAfterThrow = 0;
    const kept = await generateMap(dir, {
      resolveBinary: () => {
        throw new Error("resolveBinary should not spawn");
      },
      spawnLsp: () => {
        spawnedAfterThrow += 1;
        throw new Error("should not spawn");
      },
    });
    assert.equal(spawnedAfterThrow, 0);
    assert.equal(kept.backend, "fallback");
  });
});

test("tsx/jsx didOpen uses typescriptreact/javascriptreact", async () => {
  await withTempDir(async (dir) => {
    const logPath = join(dir, "didopen.jsonl");
    await writeTree(dir, {
      "src/widget.tsx": "export function Widget() { return null; }\n",
      "src/view.jsx": "export function View() { return null; }\n",
      "tsconfig.json": `{"compilerOptions":{"strict":true}}\n`,
    });
    await generateMap(dir, {
      lsp: "require",
      resolveBinary: (name) => (name === "typescript-language-server" ? process.execPath : null),
      spawnLsp: spawnMockLspWithLog(logPath),
    });
    const lines = (await readFile(logPath, "utf8")).trim().split(/\n/);
    const ids = Object.fromEntries(
      lines.map((line) => {
        const row = JSON.parse(line);
        const name = String(row.uri).replace(/\\/g, "/");
        return [name.slice(name.lastIndexOf("/") + 1), row.languageId];
      }),
    );
    assert.equal(ids["widget.tsx"], "typescriptreact");
    assert.equal(ids["view.jsx"], "javascriptreact");
  });
});

test("walk skips symlink directory cycles", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    try {
      await symlink(join(dir, "src"), join(dir, "src", "cycle"), process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      if (err && (err.code === "EPERM" || err.code === "EACCES")) return;
      throw err;
    }
    const result = await generateMap(dir, { roots: [] });
    const paths = result.fingerprints.modules.map((row) => row.path).sort();
    assert.deepEqual(paths, ["src/auth.ts", "src/db.ts", "src/index.ts"]);
  });
});

test("map refuses when walk exceeds 10000 modules", { timeout: 60_000 }, async () => {
  await withTempDir(async (dir) => {
    await writeManyTs(dir, 10_001);
    await assert.rejects(
      () => generateMap(dir),
      (err) => {
        assert.equal(err instanceof MapError, true);
        assert.equal(err.nextHint, "legion-cli map --no-lsp");
        assert.match(err.message, /10000/);
        return true;
      },
    );
  });
});
