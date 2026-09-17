import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { installLocalDir } from "@9thlevelsoftware/legion-cli-design-system";
import {
  assertWireframeHtml,
  HINT,
  LegionEngine,
  LegionRefuseError,
  palettePresent,
  SKIP_WIREFRAMES_NOTE,
  WIREFRAME_PALETTE,
} from "../dist/index.js";
import { initGitRepo, initProject, withEngine } from "./helpers.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
const fixtureNeutral = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "design-systems", "_fixture-neutral");

async function fillTwoScreens(engine) {
  await engine.beginIntent();
  await engine.intentTurn([
    "Teammates who keep missing who's in the office.",
    "They ping five chat apps every morning.",
  ]);
  await engine.intentTurn([
    "People can tap in or out on their phone in under five seconds.",
    "No payroll, no badges, no calendar sync in v0.",
  ]);
  await engine.intentTurn(["existing auth"]);
  await engine.intentTurn([
    "Open the board, tap In, see yourself listed, tap Out, see yourself leave.",
    "Empty board, network error, changed mind.",
  ]);
  await engine.intentTurn(["board, settings", "phone"]);
  await engine.intentTurn(["none", "none"]);
  await engine.confirmIntent({ id: "tester" });
}

async function draftWithScreens(engine) {
  await initProject(engine);
  await fillTwoScreens(engine);
  const proposed = await engine.startDiscuss();
  await engine.discuss(proposed.map((item) => ({ id: item.id, status: "accepted" })));
  return engine.draftSpec();
}

function isRefuse(err, message, hint) {
  assert.equal(err instanceof LegionRefuseError, true, `expected LegionRefuseError, got ${err?.name}: ${err?.message}`);
  if (message) assert.match(err.message, message);
  if (hint) assert.match(err.nextHint, hint);
  return true;
}

test("assertWireframeHtml allows meta content=continue and denies on*/javascript:/script", () => {
  assert.doesNotThrow(() =>
    assertWireframeHtml('<meta name="description" content="continue">'),
  );
  assert.doesNotThrow(() =>
    assertWireframeHtml('<meta name="description" content="onion">\n<p class="continue">ok</p>'),
  );
  assert.throws(() => assertWireframeHtml('<img src="x" onclick="alert(1)">'), /onclick/);
  assert.throws(() => assertWireframeHtml('<a href="javascript:alert(1)">x</a>'), /javascript:/);
  assert.throws(() => assertWireframeHtml('<a href=" JavaScript:alert(1)">x</a>'), /javascript:/);
  assert.throws(() => assertWireframeHtml('<img alt=">" src="x" onerror="alert(1)">'), /onerror/);
  assert.throws(() => assertWireframeHtml('<a title=">" href="javascript:alert(1)">x</a>'), /javascript:/);
  assert.throws(() => assertWireframeHtml("<img/onclick=alert(1)>"), /onclick/);
  assert.throws(() => assertWireframeHtml('<a href="javascript&#58;alert(1)">x</a>'), /javascript:/);
  assert.throws(() => assertWireframeHtml('<a href="javascript&colon;alert(1)">x</a>'), /javascript:/);
  assert.throws(() => assertWireframeHtml('<a href="&#106;avascript:alert(1)">x</a>'), /javascript:/);
  assert.throws(() => assertWireframeHtml('<form action="javascript:alert(1)"></form>'), /javascript:/);
  assert.throws(() => assertWireframeHtml("<script>alert(1)</script>"), /<script>/);
  assert.throws(() => assertWireframeHtml('<iframe src="x"></iframe>'), /<iframe>/);
  assert.throws(() => assertWireframeHtml('<link rel="import" href="x.html">'), /rel=import/);
});

test("draft with two screens writes INDEX + pages and palette tokens", async () => {
  await withEngine(async ({ engine, store }) => {
    const spec = await draftWithScreens(engine);
    const result = await engine.wireframe();
    assert.equal(result.specId, spec.id);
    assert.equal(result.status, "draft");
    assert.equal(result.restyled, false);
    assert.equal(result.index, `.legion-cli/specs/${spec.id}/wireframes/INDEX.html`);
    assert.equal(result.pages.length, 2);
    const dir = join(store.paths.specsDir, spec.id, "wireframes");
    const index = await readFile(join(dir, "INDEX.html"), "utf8");
    assert.equal(palettePresent(index), true);
    assert.match(index, new RegExp(WIREFRAME_PALETTE.background));
    assert.equal(existsSync(join(dir, "board.html")), true);
    assert.equal(existsSync(join(dir, "settings.html")), true);
    const board = await readFile(join(dir, "board.html"), "utf8");
    assert.match(board, /<h1>board<\/h1>/);
    assert.equal(palettePresent(board), true);
  });
});

test("rename a screen in intent-answers regenerates slug and deletes the old file", async () => {
  await withEngine(async ({ engine, store }) => {
    const spec = await draftWithScreens(engine);
    const dir = join(store.paths.specsDir, spec.id, "wireframes");
    assert.equal(existsSync(join(dir, "board.html")), true);
    const answers = await store.readIntentAnswers();
    await store.writeIntentAnswers({
      ...answers,
      mapped: { ...answers.mapped, screens: ["dashboard", "settings"] },
    });
    await engine.wireframe();
    assert.equal(existsSync(join(dir, "board.html")), false);
    assert.equal(existsSync(join(dir, "dashboard.html")), true);
    assert.equal(existsSync(join(dir, "settings.html")), true);
    const index = await readFile(join(dir, "INDEX.html"), "utf8");
    assert.match(index, /href="dashboard\.html"/);
    assert.doesNotMatch(index, /href="board\.html"/);
  });
});

test("frozen without --restyle refuses", async () => {
  await withEngine(async ({ engine }) => {
    const spec = await draftWithScreens(engine);
    await engine.approveSpec(spec.id, { id: "human" });
    await assert.rejects(
      () => engine.wireframe(),
      (err) => isRefuse(err, /CSS-only/, /wireframe --restyle/),
    );
  });
});

test("frozen --restyle with fixture package changes CSS and keeps h1 text", async () => {
  await withEngine(async ({ engine, store, dir }) => {
    const spec = await draftWithScreens(engine);
    const page = join(store.paths.specsDir, spec.id, "wireframes", "board.html");
    const before = await readFile(page, "utf8");
    await writeFile(page, before.replace("<h1>board</h1>", "<h1>Keep Me</h1>"), "utf8");
    await engine.approveSpec(spec.id, { id: "human" });
    await installLocalDir({ projectRoot: dir, source: fixtureNeutral, cwd: dir });
    const dirWf = join(store.paths.specsDir, spec.id, "wireframes");
    await writeFile(join(dirWf, "stale.html"), "<html><body>stale</body></html>\n", "utf8");
    const answers = await store.readIntentAnswers();
    await store.writeIntentAnswers({
      ...answers,
      mapped: { ...answers.mapped, screens: ["dashboard"] },
    });
    const result = await engine.wireframe({ restyle: true });
    assert.equal(result.status, "frozen");
    assert.equal(result.restyled, true);
    const after = await readFile(page, "utf8");
    assert.match(after, /<h1>Keep Me<\/h1>/);
    assert.match(after, /#0b6e4f/);
    assert.match(after, /\.screen/);
    assert.match(after, /--bg:/);
    assert.match(after, /--ink:/);
    assert.match(after, /--accent:/);
    assert.match(after, /--muted:/);
    assert.doesNotMatch(after, /#c45c26/);
    assert.equal(existsSync(join(dirWf, "board.html")), true);
    assert.equal(existsSync(join(dirWf, "settings.html")), true);
    assert.equal(existsSync(join(dirWf, "stale.html")), true);
    assert.equal(existsSync(join(dirWf, "dashboard.html")), false);
    const names = (await readdir(dirWf)).filter((name) => name.endsWith(".html")).sort();
    assert.deepEqual(names, ["INDEX.html", "board.html", "settings.html", "stale.html"]);
  });
});

test("spawn writing outside wireframes reverts", async () => {
  const previous = process.env.LEGION_CLI_ADAPTER;
  process.env.LEGION_CLI_ADAPTER = "fake";
  try {
    await withEngine(async ({ engine, dir }) => {
      await draftWithScreens(engine);
      await mkdir(join(dir, "src"), { recursive: true });
      const spawning = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [{ path: "src/secret.ts", content: "nope\n" }],
      });
      await assert.rejects(
        () => spawning.wireframe({ spawn: true }),
        (err) => isRefuse(err, /SkillContract/, /wireframe/),
      );
      assert.equal(existsSync(join(dir, "src", "secret.ts")), false);
      const spec = await engine.store.readSpec("spec-checkin");
      assert.equal(spec.data.status, "draft");
    });
  } finally {
    if (previous === undefined) delete process.env.LEGION_CLI_ADAPTER;
    else process.env.LEGION_CLI_ADAPTER = previous;
  }
});

test("spawned script/onclick/javascript: href FAILs and restores files", async () => {
  const previous = process.env.LEGION_CLI_ADAPTER;
  process.env.LEGION_CLI_ADAPTER = "fake";
  try {
    await withEngine(async ({ engine, dir, store }) => {
      const spec = await draftWithScreens(engine);
      const page = join(store.paths.specsDir, spec.id, "wireframes", "board.html");
      const before = await readFile(page, "utf8");
      const spawning = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [
          {
            path: ".legion-cli/specs/spec-checkin/wireframes/board.html",
            content: `${before.replace("<h1>board</h1>", '<h1>board</h1><img src="x" onclick="alert(1)">')}`,
          },
        ],
      });
      await assert.rejects(
        () => spawning.wireframe({ spawn: true }),
        (err) => isRefuse(err, /onclick/, /wireframe/),
      );
      const restored = await readFile(page, "utf8");
      assert.equal(restored, before);
      assert.doesNotMatch(restored, /onclick/);
    });
  } finally {
    if (previous === undefined) delete process.env.LEGION_CLI_ADAPTER;
    else process.env.LEGION_CLI_ADAPTER = previous;
  }
});

test("spawned meta content=continue does not trip the on* policy", async () => {
  const previous = process.env.LEGION_CLI_ADAPTER;
  process.env.LEGION_CLI_ADAPTER = "fake";
  try {
    await withEngine(async ({ engine, dir, store }) => {
      const spec = await draftWithScreens(engine);
      const page = join(store.paths.specsDir, spec.id, "wireframes", "board.html");
      const before = await readFile(page, "utf8");
      const injected = before.replace(
        '<meta charset="utf-8">',
        '<meta charset="utf-8">\n  <meta name="description" content="continue">',
      );
      const spawning = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [
          {
            path: ".legion-cli/specs/spec-checkin/wireframes/board.html",
            content: injected,
          },
        ],
      });
      const result = await spawning.wireframe({ spawn: true });
      assert.equal(result.status, "draft");
      const after = await readFile(page, "utf8");
      assert.match(after, /content="continue"/);
      assert.equal(palettePresent(after), true);
    });
  } finally {
    if (previous === undefined) delete process.env.LEGION_CLI_ADAPTER;
    else process.env.LEGION_CLI_ADAPTER = previous;
  }
});

test("wireframe after --skip-wireframes writes files, clears skip note, does not approve", async () => {
  await withEngine(async ({ engine, store }) => {
    await initProject(engine);
    await fillTwoScreens(engine);
    const proposed = await engine.startDiscuss();
    await engine.discuss(proposed.map((item) => ({ id: item.id, status: "accepted" })));
    const spec = await engine.draftSpec({ skipWireframes: true });
    assert.equal(spec.wireframesIndex ?? null, null);
    const before = await store.readSpec(spec.id);
    assert.match(before.body, new RegExp(SKIP_WIREFRAMES_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const result = await engine.wireframe();
    assert.equal(result.status, "draft");
    const after = await store.readSpec(spec.id);
    assert.equal(after.data.status, "draft");
    assert.equal(after.data.wireframesIndex, "wireframes/INDEX.html");
    assert.doesNotMatch(after.body, /skip-wireframes/);
    assert.equal(existsSync(join(store.paths.specsDir, spec.id, "wireframes", "INDEX.html")), true);
    assert.equal((await engine.getState()).phase, "spec_draft");
  });
});

test("uninitialized and missing spec refuse HINT.spec", async () => {
  await withEngine(async ({ engine }) => {
    await assert.rejects(
      () => engine.wireframe(),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /no active spec/);
        assert.equal(err.nextHint, HINT.spec);
        return true;
      },
    );
    await initProject(engine);
    await assert.rejects(
      () => engine.wireframe(),
      (err) => {
        assert.equal(err instanceof LegionRefuseError, true);
        assert.match(err.message, /no active spec/);
        assert.equal(err.nextHint, HINT.spec);
        return true;
      },
    );
  });
});

test("nested spawn html and non-html extras are removed; SPEC.md restored when dirty", async () => {
  const previous = process.env.LEGION_CLI_ADAPTER;
  process.env.LEGION_CLI_ADAPTER = "fake";
  try {
    await withEngine(async ({ engine, dir, store }) => {
      await initProject(engine);
      initGitRepo(dir);
      await fillTwoScreens(engine);
      const proposed = await engine.startDiscuss();
      await engine.discuss(proposed.map((item) => ({ id: item.id, status: "accepted" })));
      await engine.draftSpec();
      const specPath = join(store.paths.specsDir, "spec-checkin", "SPEC.md");
      const beforeSpec = await readFile(specPath, "utf8");
      const spawning = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [
          {
            path: ".legion-cli/specs/spec-checkin/wireframes/evil/pwn.html",
            content: "<html><body><script>alert(1)</script></body></html>\n",
          },
          {
            path: ".legion-cli/specs/spec-checkin/wireframes/payload.svg",
            content: "<svg></svg>\n",
          },
          {
            path: ".legion-cli/specs/spec-checkin/SPEC.md",
            content: `${beforeSpec}\nSpawned rewrite.\n`,
          },
        ],
      });
      await assert.rejects(
        () => spawning.wireframe({ spawn: true }),
        (err) => isRefuse(err, /<script>/, /wireframe/),
      );
      assert.equal(existsSync(join(store.paths.specsDir, "spec-checkin", "wireframes", "evil", "pwn.html")), false);
      assert.equal(existsSync(join(store.paths.specsDir, "spec-checkin", "wireframes", "payload.svg")), false);
      assert.equal(await readFile(specPath, "utf8"), beforeSpec);
    });
  } finally {
    if (previous === undefined) delete process.env.LEGION_CLI_ADAPTER;
    else process.env.LEGION_CLI_ADAPTER = previous;
  }
});

test("frozen --restyle --spawn keeps markup and only applies style", async () => {
  const previous = process.env.LEGION_CLI_ADAPTER;
  process.env.LEGION_CLI_ADAPTER = "fake";
  try {
    await withEngine(async ({ engine, dir, store }) => {
      const spec = await draftWithScreens(engine);
      const page = join(store.paths.specsDir, spec.id, "wireframes", "board.html");
      const before = await readFile(page, "utf8");
      await writeFile(page, before.replace("<h1>board</h1>", "<h1>Keep Me</h1>"), "utf8");
      await engine.approveSpec(spec.id, { id: "human" });
      await installLocalDir({ projectRoot: dir, source: fixtureNeutral, cwd: dir });
      const restyled = await readFile(page, "utf8");
      const spawnedHtml = restyled
        .replace("<h1>Keep Me</h1>", "<h1>Spawned</h1>")
        .replace("</style>", "body { outline: 2px solid #0b6e4f; }\n</style>");
      const spawning = new LegionEngine(dir, undefined, {
        skillsDir,
        fakeArtifacts: [
          { path: ".legion-cli/specs/spec-checkin/wireframes/board.html", content: spawnedHtml },
        ],
      });
      const result = await spawning.wireframe({ restyle: true, spawn: true });
      assert.equal(result.status, "frozen");
      const after = await readFile(page, "utf8");
      assert.match(after, /<h1>Keep Me<\/h1>/);
      assert.doesNotMatch(after, /<h1>Spawned<\/h1>/);
      assert.match(after, /outline: 2px solid #0b6e4f/);
      assert.equal(existsSync(join(store.paths.specsDir, spec.id, "wireframes", "board.html")), true);
      assert.equal(existsSync(join(store.paths.specsDir, spec.id, "wireframes", "settings.html")), true);
    });
  } finally {
    if (previous === undefined) delete process.env.LEGION_CLI_ADAPTER;
    else process.env.LEGION_CLI_ADAPTER = previous;
  }
});
