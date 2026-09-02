import assert from "node:assert/strict";
import test from "node:test";

import {
  filesAllowedFailsPlan,
  isTaskReady,
  overlappingFilesAllowed,
  pickNextTask,
  readyTasks,
  unresolvedBlockers,
} from "../dist/index.js";

function task(overrides = {}) {
  const { contract, ...rest } = overrides;
  return {
    schemaVersion: "legion-cli-task/v1",
    id: "TSK-0001",
    title: "in/out",
    status: "ready",
    type: "feature",
    priority: "P0",
    specId: "spec-checkin",
    blockedBy: [],
    blocks: [],
    assignee: "agent",
    notes: "",
    ...rest,
    contract: {
      filesAllowed: ["src/main.ts"],
      filesForbidden: [".git/**"],
      expectedArtifacts: ["src/main.ts"],
      verificationCommands: ["pnpm test"],
      maxFilesTouched: 20,
      ...contract,
    },
  };
}

function ctx(tasks, extra = {}) {
  return {
    phase: extra.phase ?? "plan_ready",
    controlMode: extra.controlMode ?? "guarded",
    tasks,
    assumptions: extra.assumptions ?? [],
  };
}

test("filesAllowedFailsPlan rejects empty, globs, .git, and implicit forbidden", () => {
  assert.equal(filesAllowedFailsPlan([]), true);
  assert.equal(filesAllowedFailsPlan(["src/**"]), true);
  assert.equal(filesAllowedFailsPlan(["src/*.ts"]), true);
  assert.equal(filesAllowedFailsPlan(["src/foo?.ts"]), true);
  assert.equal(filesAllowedFailsPlan([".git/config"]), true);
  assert.equal(filesAllowedFailsPlan([".env"]), true);
  assert.equal(filesAllowedFailsPlan([".env.local"]), true);
  assert.equal(filesAllowedFailsPlan([".legion-cli/config.yaml"]), true);
  assert.equal(filesAllowedFailsPlan([".legion-cli/index/engine.lock"]), true);
  assert.equal(filesAllowedFailsPlan(["src/main.ts"]), false);
});

test("overlapping filesAllowed is exclusive in v0", () => {
  const overlaps = overlappingFilesAllowed([
    task({ id: "TSK-0001" }),
    task({
      id: "TSK-0002",
      contract: { filesAllowed: ["src/main.ts"], expectedArtifacts: ["src/main.ts"] },
    }),
  ]);
  assert.equal(overlaps.length, 1);
  assert.match(overlaps[0], /src\/main\.ts/);
  assert.deepEqual(
    overlappingFilesAllowed([
      task({ id: "TSK-0001" }),
      task({
        id: "TSK-0002",
        contract: { filesAllowed: ["src/board.ts"], expectedArtifacts: ["src/board.ts"] },
      }),
    ]),
    [],
  );
});

test("§4.1 ready requires done blockers, verification, concrete files, phase, and serial", () => {
  const blocked = task({ id: "TSK-0002", blockedBy: ["TSK-0001"], status: "todo" });
  const parent = task({ id: "TSK-0001", status: "ready", blocks: ["TSK-0002"] });
  assert.deepEqual(unresolvedBlockers(blocked, [parent, blocked]), ["TSK-0001"]);
  assert.equal(isTaskReady(blocked, ctx([parent, blocked])), false);

  const doneParent = task({ id: "TSK-0001", status: "done", blocks: ["TSK-0002"] });
  const unblocked = task({
    id: "TSK-0002",
    status: "todo",
    blockedBy: ["TSK-0001"],
    contract: { filesAllowed: ["src/board.ts"], expectedArtifacts: ["src/board.ts"] },
  });
  assert.equal(isTaskReady(unblocked, ctx([doneParent, unblocked])), true);

  const compactedParent = task({ id: "TSK-0001", status: "compacted", blocks: ["TSK-0002"] });
  assert.deepEqual(unresolvedBlockers(unblocked, [compactedParent, unblocked]), []);
  assert.equal(isTaskReady(unblocked, ctx([compactedParent, unblocked])), true);

  assert.equal(
    isTaskReady(task({ contract: { verificationCommands: [] } }), ctx([task({ contract: { verificationCommands: [] } })])),
    false,
  );
  assert.equal(isTaskReady(task(), ctx([task()], { phase: "spec_frozen" })), false);
  assert.equal(isTaskReady(task(), ctx([task()], { controlMode: "advisory" })), false);

  const running = task({ id: "TSK-0001", status: "in_progress" });
  const other = task({
    id: "TSK-0002",
    status: "ready",
    contract: { filesAllowed: ["src/board.ts"], expectedArtifacts: ["src/board.ts"] },
  });
  assert.equal(isTaskReady(other, ctx([running, other])), false);
});

test("open blocking user assumption in the subgraph blocks ready", () => {
  const t = task();
  assert.equal(
    isTaskReady(
      t,
      ctx([t], {
        assumptions: [
          {
            schemaVersion: "legion-cli-assumption/v1",
            id: "ASM-0001",
            statement: "Need a phone number?",
            status: "open",
            blocking: true,
            escalatesTo: "user",
            createdIn: "intent",
          },
        ],
      }),
    ),
    false,
  );
  assert.equal(
    isTaskReady(
      t,
      ctx([t], {
        assumptions: [
          {
            schemaVersion: "legion-cli-assumption/v1",
            id: "ASM-0002",
            statement: "Nice to have dark mode",
            status: "open",
            blocking: false,
            escalatesTo: "user",
            createdIn: "intent",
          },
        ],
      }),
    ),
    true,
  );
});

test("readyTasks is P0 then oldest id", () => {
  const p1 = task({
    id: "TSK-0001",
    priority: "P1",
    contract: { filesAllowed: ["src/a.ts"], expectedArtifacts: ["src/a.ts"] },
  });
  const p0b = task({
    id: "TSK-0003",
    priority: "P0",
    contract: { filesAllowed: ["src/c.ts"], expectedArtifacts: ["src/c.ts"] },
  });
  const p0a = task({
    id: "TSK-0002",
    priority: "P0",
    contract: { filesAllowed: ["src/b.ts"], expectedArtifacts: ["src/b.ts"] },
  });
  const ready = readyTasks(ctx([p1, p0b, p0a]));
  assert.deepEqual(
    ready.map((item) => item.id),
    ["TSK-0002", "TSK-0003", "TSK-0001"],
  );
  assert.equal(pickNextTask(ctx([p1, p0b, p0a])).id, "TSK-0002");
});
