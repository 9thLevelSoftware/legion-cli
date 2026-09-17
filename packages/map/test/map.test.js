import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  GENERATED_END,
  GENERATED_START,
  MapError,
  fingerprintHash,
  generateMap,
  parseSource,
} from "../dist/index.js";
import { THREE_TS, spawnMockLsp, withTempDir, writeTree } from "./helpers.js";

function moduleOf(result, path) {
  return result.fingerprints.modules.find((row) => row.path === path);
}

test("fallback parser: three TS files, stable hash; comment-only does not churn; export add does", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    const first = await generateMap(dir);
    assert.equal(first.backend, "fallback");
    assert.equal(first.fingerprints.schemaVersion, "legion-cli-fingerprint/v1");
    assert.equal(first.fingerprints.modules.length, 3);

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

    await writeFile(join(dir, "src", "auth.ts"), `${THREE_TS["src/auth.ts"]}\n// comment only\n`, "utf8");
    const commented = await generateMap(dir);
    assert.equal(moduleOf(commented, "src/auth.ts").hash, auth.hash);
    assert.equal(commented.fingerprints.rootHash, first.fingerprints.rootHash);

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

test("--lsp mock server: two depth-0 Function symbols become exports; hash stable", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, THREE_TS);
    const opts = {
      lsp: "require",
      resolveBinary: (name) => (name === "typescript-language-server" ? process.execPath : null),
      spawnLsp: spawnMockLsp,
    };
    const first = await generateMap(dir, opts);
    assert.equal(first.backend, "lsp");
    const auth = moduleOf(first, "src/auth.ts");
    assert.deepEqual(auth.exports, ["alpha", "beta"]);
    assert.equal(auth.exports.includes("nested"), false);
    assert.deepEqual(auth.imports, ["./db.js"]);
    assert.equal(auth.hash, fingerprintHash("src/auth.ts", ["alpha", "beta"], ["./db.js"]));

    const second = await generateMap(dir, opts);
    assert.equal(second.backend, "lsp");
    assert.equal(moduleOf(second, "src/auth.ts").hash, auth.hash);
    assert.equal(second.fingerprints.rootHash, first.fingerprints.rootHash);
  });
});

test("walk skips .legion-cli/map, node_modules, and default test globs", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, {
      ...THREE_TS,
      ".legion-cli/map/leaked.ts": "export function leaked() {}\n",
      "node_modules/pkg/index.ts": "export function nm() {}\n",
      "src/auth.test.ts": "export function testOnly() {}\n",
      "src/auth.spec.ts": "export function specOnly() {}\n",
    });
    const result = await generateMap(dir);
    const paths = result.fingerprints.modules.map((row) => row.path).sort();
    assert.deepEqual(paths, ["src/auth.ts", "src/db.ts", "src/index.ts"]);
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
