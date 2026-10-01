import assert from "node:assert/strict";
import test from "node:test";

import { serializeJsonLine } from "../dist/io.js";

test("interactive JSON events serialize as one compact physical JSON line", () => {
  const line = serializeJsonLine({ kind: "next", next: "legion-cli intent" });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.split("\n").length, 2);
  assert.doesNotMatch(line, /\n\s+"/);
  assert.deepEqual(JSON.parse(line), { kind: "next", next: "legion-cli intent" });
});
