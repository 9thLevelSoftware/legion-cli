import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import { normalize, runCli, withTempDir } from "./helpers.js";

async function patchPhase(dir, phase) {
  const engine = createLegionEngine(dir);
  const state = await engine.store.readState();
  await engine.store.writeState({ ...state.data, phase }, state.body);
  return engine;
}

test("chat --once where am I prints status and does not spawn", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);
    const result = runCli(["chat", "--once", "where am I", "--project", dir]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const out = normalize(result.stdout);
    assert.match(out, /phase: initialized/);
    assert.match(out, /legion-cli intent/);
    const runs = join(dir, ".legion-cli", "cache", "runs");
    assert.equal(existsSync(runs), false);
  });
});

test("chat --once two intent answers prints a proposal and does not write intent-answers.yaml", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    await patchPhase(dir, "intent_draft");
    const result = runCli([
      "chat",
      "--once",
      "Teammates who keep missing who's in the office.\nThey ping five chat apps every morning.",
      "--project",
      dir,
    ]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const out = normalize(`${result.stdout}\n${result.stderr}`);
    assert.match(out, /Proposed:/);
    assert.match(out, /Next: legion-cli intent/);
    assert.equal(existsSync(join(dir, ".legion-cli", "wiki", "product", "intent-answers.yaml")), false);
  });
});

test("discuss via chat with --yes still refuses", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const engine = await patchPhase(dir, "discussing");
    await engine.store.writeDiscuss(
      {
        schemaVersion: "legion-cli-discuss/v1",
        decisions: [{ id: "D-001", statement: "Ship as mobile web.", status: "proposed" }],
      },
      "Proposed decisions.\n",
    );
    const result = runCli(["chat", "--yes", "--once", "Y", "--project", dir]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const err = normalize(result.stderr);
    assert.match(err, /cannot skip product decisions/);
    assert.match(err, /Next: legion-cli discuss/);
    const discussMd = await readFile(join(dir, ".legion-cli", "discuss", "DISCUSS.md"), "utf8");
    assert.doesNotMatch(discussMd, /status: accepted/);
  });
});

test("chat --adapter http is refused", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["chat", "--once", "where am I", "--adapter", "http", "--project", dir]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const err = normalize(result.stderr);
    assert.match(err, /adapter http is not selectable yet/);
    assert.doesNotMatch(err, /\|http/);
  });
});

test("chat without --once on non-TTY refuses", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const result = runCli(["chat", "--project", dir]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const err = normalize(result.stderr);
    assert.match(err, /TTY|--once/);
    assert.match(err, /Next: legion-cli chat --once or legion-cli status/);
  });
});

test("model fixture discuss_decide does not write DISCUSS.md without Y", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const engine = await patchPhase(dir, "discussing");
    await engine.store.writeDiscuss(
      {
        schemaVersion: "legion-cli-discuss/v1",
        decisions: [{ id: "D-001", statement: "Ship as mobile web.", status: "proposed" }],
      },
      "Proposed decisions.\n",
    );
    const before = await readFile(join(dir, ".legion-cli", "discuss", "DISCUSS.md"), "utf8");
    const result = runCli(["chat", "--once", "ok", "--project", dir], {
      env: {
        LEGION_CLI_CHAT_ACTION: JSON.stringify({ type: "discuss_decide", id: "D-001", status: "accepted" }),
      },
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const out = normalize(`${result.stdout}\n${result.stderr}`);
    assert.match(out, /Proposed:/);
    assert.match(out, /Next: legion-cli discuss/);
    const after = await readFile(join(dir, ".legion-cli", "discuss", "DISCUSS.md"), "utf8");
    assert.equal(after, before);
    assert.doesNotMatch(after, /status: accepted/);
  });
});

test("model fixture ship is dropped and stdout contains Next:", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const dropped = runCli(["chat", "--once", "ship it", "--project", dir], {
      env: { LEGION_CLI_CHAT_ACTION: JSON.stringify({ type: "ship" }) },
    });
    assert.equal(dropped.status, 0, `${dropped.stdout}\n${dropped.stderr}`);
    const droppedOut = normalize(dropped.stdout);
    assert.match(droppedOut, /Dropped/);
    assert.match(droppedOut, /Next:/);
    const fallback = runCli(["chat", "--once", "ship it", "--project", dir]);
    assert.equal(fallback.status, 0, `${fallback.stdout}\n${fallback.stderr}`);
    assert.doesNotMatch(normalize(fallback.stdout), /Dropped/);
  });
});

test("chat --once without init refuses", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["chat", "--once", "where am I", "--project", dir]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const err = normalize(result.stderr);
    assert.match(err, /refused until init|needs a Legion CLI project|uninitialized/i);
    assert.match(err, /Next:/);
  });
});

test("chat --once empty or whitespace refuses", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    for (const utterance of ["", "   "]) {
      const result = runCli(["chat", "--once", utterance, "--project", dir]);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      const err = normalize(result.stderr);
      assert.match(err, /utterance/i);
      assert.match(err, /Next:/);
    }
  });
});

test("chat --once --json pause emits one JSON object", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    let last;
    for (let i = 0; i < 4; i++) {
      last = runCli(["chat", "--once", `hello ${i}`, "--json", "--project", dir]);
      assert.equal(last.status, 0, `${last.stdout}\n${last.stderr}`);
      const body = JSON.parse(last.stdout);
      assert.equal(body.kind, "next");
      assert.equal(body.next, "legion-cli intent");
      if (i < 3) assert.equal(body.paused, false);
      else {
        assert.equal(body.paused, true);
        assert.doesNotMatch(last.stdout, /\}\s*\{/);
      }
    }
  });
});

test("paused search --json folds paused into one object", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    let last;
    for (let i = 0; i < 4; i++) {
      last = runCli(["chat", "--once", `hello ${i}`, "--json", "--project", dir], {
        env: { LEGION_CLI_CHAT_ACTION: JSON.stringify({ type: "search", q: "office" }) },
      });
      assert.equal(last.status, 0, `${last.stdout}\n${last.stderr}`);
      const body = JSON.parse(last.stdout);
      assert.ok("hits" in body);
      assert.equal(body.query, "office");
      if (i < 3) assert.equal("paused" in body, false);
      else {
        assert.equal(body.paused, true);
        assert.match(body.next, /legion-cli intent/);
      }
    }
  });
});

test("four idle --once turns print the read then one pause Next", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    let last;
    for (let i = 0; i < 4; i++) {
      last = runCli(["chat", "--once", `hello ${i}`, "--project", dir]);
      if (i < 3) {
        assert.equal(last.status, 0, `${last.stdout}\n${last.stderr}`);
        assert.doesNotMatch(normalize(last.stdout), /Chat paused/);
        assert.match(normalize(last.stdout), /Next: legion-cli intent/);
      }
    }
    assert.equal(last.status, 0, `${last.stdout}\n${last.stderr}`);
    const out = normalize(last.stdout);
    assert.match(out, /Next: legion-cli intent/);
    assert.match(out, /Chat paused/);
    assert.ok(out.indexOf("Next:") < out.indexOf("Chat paused"));
    assert.equal([...out.matchAll(/Next:/g)].length, 1);
    const chatDir = join(dir, ".legion-cli", "chat");
    const files = await readdir(chatDir);
    assert.ok(files.some((name) => name.endsWith(".json")));
  });
});

test("chat start ensures .legion-cli/chat/ is gitignored", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const gi = join(dir, ".gitignore");
    const before = await readFile(gi, "utf8");
    await writeFile(gi, before.replace(/^\.legion-cli\/chat\/\r?\n?/m, ""), "utf8");
    assert.doesNotMatch(await readFile(gi, "utf8"), /\.legion-cli\/chat\//);
    const result = runCli(["chat", "--once", "where am I", "--project", dir]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(await readFile(gi, "utf8"), /\.legion-cli\/chat\//);
  });
});
