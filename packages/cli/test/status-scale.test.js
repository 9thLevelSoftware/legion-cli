import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { persistWork, resetPersistWork, writeMarkdownFile } from "@9thlevelsoftware/legion-cli-persist";
import { allowCopyJail, withTempDir } from "./helpers.js";
import { runStatus } from "../dist/status.js";

const TASK_COUNT = 24;

function cliOpts(project) {
  return { project, json: true, yes: false, verbose: false, blockers: false, plain: false };
}

function makeTask(overrides = {}) {
  const { contract, ...rest } = overrides;
  return {
    schemaVersion: "legion-cli-task/v1",
    id: "TSK-0001",
    title: "in/out button",
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

test("F-048 bare status does not read every task file", async () => {
  await withTempDir(async (dir) => {
    const engine = createLegionEngine(dir);
    await engine.init({ name: "Checkin", adapter: "fake" });
    await allowCopyJail(engine.store);
    await engine.store.writeState(
      {
        schemaVersion: "legion-cli-state/v1",
        phase: "executing",
        activeSpecId: "spec-checkin",
        currentTaskId: "TSK-0001",
        lastReadiness: "PASS",
        lastReview: null,
        lastQaId: null,
      },
      "executing\n",
    );
    await mkdir(join(dir, ".legion-cli", "tasks"), { recursive: true });
    for (let i = 1; i <= TASK_COUNT; i += 1) {
      const id = `TSK-${String(i).padStart(4, "0")}`;
      const data = makeTask({
        id,
        title: id,
        status: i === 1 ? "in_progress" : "todo",
        specId: "spec-checkin",
      });
      await writeMarkdownFile(join(dir, ".legion-cli", "tasks", `${id}.md`), data, `${id} body\n`, {
        root: dir,
      });
    }
    resetPersistWork();
    const code = await runStatus(cliOpts(dir));
    assert.equal(typeof code, "number");
    assert.ok(
      persistWork.taskFileReads <= 1,
      `bare status read ${persistWork.taskFileReads} task files; bound is 1 (not ${TASK_COUNT})`,
    );
  });
});

test("F-048 invalid status: Ready is not a slice task and does not flip next", async () => {
  await withTempDir(async (dir) => {
    const engine = createLegionEngine(dir);
    await engine.init({ name: "Checkin", adapter: "fake" });
    await allowCopyJail(engine.store);
    await engine.store.writeState(
      {
        schemaVersion: "legion-cli-state/v1",
        phase: "executing",
        activeSpecId: "spec-checkin",
        currentTaskId: null,
        lastReadiness: "PASS",
        lastReview: "PASS",
        lastQaId: null,
      },
      "executing\n",
    );
    await mkdir(join(dir, ".legion-cli", "tasks"), { recursive: true });
    const done = makeTask({ id: "TSK-0001", title: "done work", status: "done" });
    await writeMarkdownFile(join(dir, ".legion-cli", "tasks", "TSK-0001.md"), done, "done\n", { root: dir });
    await writeFile(
      join(dir, ".legion-cli", "tasks", "TSK-0099.md"),
      `---
schemaVersion: legion-cli-task/v1
id: TSK-0099
title: broken
status: Ready
type: feature
priority: P0
specId: spec-checkin
blockedBy: []
blocks: []
contract:
  filesAllowed:
    - src/main.ts
  filesForbidden:
    - .git/**
  expectedArtifacts:
    - src/main.ts
  verificationCommands:
    - pnpm test
assignee: agent
notes: ""
---

invalid
`,
      "utf8",
    );
    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return orig(chunk, ...rest);
    };
    try {
      await runStatus(cliOpts(dir));
    } finally {
      process.stdout.write = orig;
    }
    const payload = JSON.parse(chunks.join(""));
    assert.equal(payload.next.run, "legion-cli qa");
    assert.equal(payload.blockers.length, 0);
  });
});
