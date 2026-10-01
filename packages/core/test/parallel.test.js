import assert from "node:assert/strict";
import test from "node:test";

import { contractsAreDisjoint, selectParallelTasks } from "../dist/parallel.js";
import { makeTask } from "./helpers.js";

test("parallel task selection is stable, bounded, and skips overlapping contracts", () => {
  const first = makeTask({ id: "TSK-0001" });
  const overlapping = makeTask({
    id: "TSK-0002",
    contract: { filesAllowed: ["src"], expectedArtifacts: ["src/board.ts"] },
  });
  const disjoint = makeTask({
    id: "TSK-0003",
    contract: { filesAllowed: ["docs/readme.md"], expectedArtifacts: ["docs/readme.md"] },
  });

  assert.equal(contractsAreDisjoint(first.contract, overlapping.contract), false);
  assert.equal(contractsAreDisjoint(first.contract, disjoint.contract), true);
  assert.deepEqual(selectParallelTasks([first, overlapping, disjoint], 2).map((task) => task.id), [
    "TSK-0001",
    "TSK-0003",
  ]);
});
