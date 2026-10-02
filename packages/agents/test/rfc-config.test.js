import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { extraArgvIsSpawnable } from "../dist/index.js";
import { pkgRoot } from "./helpers.js";

const rfcPath = join(pkgRoot, "..", "..", "docs", "design", "adapter-routing.md");
const EXTRAS = ["grok", "codex", "openai", "mimo", "minimax"];

test("adapter-routing RFC sample configs are spawnable (F-024)", async () => {
  const text = (await readFile(rfcPath, "utf8")).replace(/\r\n/g, "\n");
  let checked = 0;
  for (const match of text.matchAll(/```yaml\n([\s\S]*?)```/g)) {
    let doc;
    try {
      doc = parse(match[1]);
    } catch {
      continue; // front-matter fragments and pseudo-yaml are not configs
    }
    const adapter = doc && typeof doc === "object" ? doc.adapter : undefined;
    if (!adapter || typeof adapter !== "object") continue;
    for (const id of EXTRAS) {
      const block = adapter[id];
      if (!block || !Array.isArray(block.args)) continue;
      assert.ok(
        extraArgvIsSpawnable(id, block.args, block.binary),
        `RFC sample adapter.${id}.args ${JSON.stringify(block.args)} is refused by extraArgvIsSpawnable`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 3, `expected the RFC to show grok, codex and minimax args (checked ${checked})`);
});

test("adapter-routing RFC trust-warning samples show spawnable args (F-024)", async () => {
  const text = (await readFile(rfcPath, "utf8")).replace(/\r\n/g, "\n");
  let checked = 0;
  for (const match of text.matchAll(/^\s*(grok|codex|openai|mimo|minimax) args are set \(trust warning\): (.+)$/gm)) {
    const args = match[2].trim().split(/\s+/);
    assert.ok(extraArgvIsSpawnable(match[1], args), `RFC warning sample for ${match[1]}: ${match[2]}`);
    checked += 1;
  }
  assert.ok(checked >= 1);
});
