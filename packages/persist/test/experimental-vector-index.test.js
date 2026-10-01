import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  experimentalVectorIndexAvailability,
  queryExperimentalVectorIndex,
  rebuildExperimentalVectorIndex,
} from "../dist/index.js";

test("experimental sqlite-vec index explicitly reports unavailable or rebuilds and queries deterministically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-vector-index-"));
  try {
    const availability = experimentalVectorIndexAvailability(dir);
    if (!availability.available) {
      assert.match(availability.reason, /sqlite-vec|extension/i);
      const rebuilt = rebuildExperimentalVectorIndex(dir, [{ id: "a", vector: [1, 0] }]);
      assert.equal(rebuilt.available, false);
      const queried = queryExperimentalVectorIndex(dir, [1, 0]);
      assert.equal(queried.available, false);
      return;
    }

    const rebuilt = rebuildExperimentalVectorIndex(dir, [
      { id: "z", vector: [1, 0] },
      { id: "a", vector: [1, 0] },
      { id: "other", vector: [0, 1] },
    ]);
    assert.deepEqual(rebuilt, { available: true, count: 3, dimensions: 2 });
    const queried = queryExperimentalVectorIndex(dir, [1, 0]);
    assert.equal(queried.available, true);
    assert.deepEqual(queried.results.map((result) => result.id), ["a", "z", "other"]);
    assert.equal(queried.results[0].distance, 0);
    assert.equal(queried.results[1].distance, 0);
    assert.ok(Math.abs(queried.results[2].distance - Math.SQRT2) < 0.000001);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
