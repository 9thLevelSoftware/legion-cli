import assert from "node:assert/strict";
import test from "node:test";

import { canonicalManifestJson } from "../dist/index.js";

test("manifest canonical bytes retain legacy optional omission and top-level integrity exclusion", () => {
  const manifest = {
    name: "Brand",
    schemaVersion: "legion-cli-design-system/v1",
    id: "brand",
    description: "Quoted \"brand\"\n",
    source: { origin: "brand-local", type: "local" },
    files: { usage: undefined, tokens: "tokens.css", design: "DESIGN.md" },
    wcag: undefined,
    integrity: { sha256: "a".repeat(64), minisign: "private signature" },
  };
  const expected = '{"description":"Quoted \\"brand\\"\\n","files":{"design":"DESIGN.md","tokens":"tokens.css"},"id":"brand","name":"Brand","schemaVersion":"legion-cli-design-system/v1","source":{"origin":"brand-local","type":"local"}}';
  const actual = canonicalManifestJson(manifest);
  assert.equal(actual, expected);
  assert.equal(canonicalManifestJson({ ...manifest, integrity: { sha256: "b".repeat(64) } }), expected);
  const { integrity: _integrity, ...withoutIntegrity } = manifest;
  assert.equal(canonicalManifestJson(withoutIntegrity), expected);
});

test("manifest canonicalization retains nested integrity data and UTF-16 ordering", () => {
  const manifest = {
    "\ue000": 1,
    "𐀀": 2,
    nested: { integrity: "ordinary nested data", absent: undefined },
    list: [{ z: 1, a: 2 }, "second", "first"],
    integrity: { sha256: "discarded top-level data" },
  };
  assert.equal(
    canonicalManifestJson(manifest),
    '{"list":[{"a":2,"z":1},"second","first"],"nested":{"integrity":"ordinary nested data"},"𐀀":2,"\ue000":1}',
  );
});
