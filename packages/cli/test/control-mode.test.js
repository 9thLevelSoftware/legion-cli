import assert from "node:assert/strict";
import test from "node:test";

import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";

import { normalize, runCli, withTempDir } from "./helpers.js";

test("control-mode is off Layer 1", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(normalize(result.stdout), /control-mode/);
});

test("help --all lists control-mode in always-on, not later or v0 gap", () => {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const out = normalize(result.stdout);
  assert.match(out, /Always-on operations:[\s\S]*control-mode \[mode\]/);
  assert.doesNotMatch(out, /Later, not this series:[\s\S]*control-mode/);
  assert.doesNotMatch(out, /Later, not this series:[\s\S]*vendor extra-adapter argv/);
  assert.doesNotMatch(out, /v0 gap; follow-up PRs in this series/);
  assert.doesNotMatch(out, /v0 gap/);
  assert.match(out, /Later, not this series:\n {2}map, wireframe, skills list\|install, serve/);
});

test("control-mode shows default guarded and sets surgical|advisory", async () => {
  await withTempDir(async (dir) => {
    const init = runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    assert.equal(init.status, 0, init.stderr);

    const shown = runCli(["control-mode", "--project", dir]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(normalize(shown.stdout), /^control_mode: guarded$/m);

    const jsonShow = runCli(["control-mode", "--project", dir, "--json"]);
    assert.equal(jsonShow.status, 0, jsonShow.stderr);
    assert.equal(JSON.parse(jsonShow.stdout).control_mode, "guarded");

    const engine = createLegionEngine(dir);
    const surgical = runCli(["control-mode", "surgical", "--project", dir]);
    assert.equal(surgical.status, 0, surgical.stderr);
    assert.match(normalize(surgical.stdout), /^control_mode: surgical$/m);
    assert.match(normalize(surgical.stdout), /^Next: legion-cli doctor$/m);
    assert.equal((await engine.store.readConfig()).control_mode, "surgical");
    assert.equal((await engine.store.readProject()).data.controlMode, "surgical");

    const jsonSet = runCli(["control-mode", "advisory", "--project", dir, "--json"]);
    assert.equal(jsonSet.status, 0, jsonSet.stderr);
    const payload = JSON.parse(jsonSet.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.control_mode, "advisory");
    assert.equal(payload.next, "legion-cli doctor");
    assert.equal((await engine.store.readConfig()).control_mode, "advisory");
    assert.equal((await engine.store.readProject()).data.controlMode, "advisory");
  });
});

test("control-mode autonomous and unknown modes refuse", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);

    const autonomous = runCli(["control-mode", "autonomous", "--project", dir]);
    assert.equal(autonomous.status, 1);
    const autoErr = normalize(autonomous.stderr);
    assert.match(autoErr, /Autonomous mode is not allowed/);
    assert.match(autoErr, /Next: legion-cli control-mode/);

    const unknown = runCli(["control-mode", "yolo", "--project", dir]);
    assert.equal(unknown.status, 1);
    const unknownErr = normalize(unknown.stderr);
    assert.match(unknownErr, /control_mode yolo is rejected/);
    assert.match(unknownErr, /Next: legion-cli control-mode/);

    const engine = createLegionEngine(dir);
    assert.equal((await engine.store.readConfig()).control_mode, "guarded");
  });
});

test("execute in advisory refuses with Next control-mode guarded", async () => {
  await withTempDir(async (dir) => {
    runCli(["init", "--project", dir, "--name", "Checkin", "--adapter", "fake"]);
    const set = runCli(["control-mode", "advisory", "--project", dir]);
    assert.equal(set.status, 0, set.stderr);

    const result = runCli(["execute", "--project", dir], { env: { LEGION_CLI_ADAPTER: "fake" } });
    assert.equal(result.status, 1);
    const err = normalize(result.stderr);
    assert.match(err, /Execute is off in advisory mode/);
    assert.match(err, /Next: legion-cli control-mode guarded/);
  });
});

test("control-mode before init refuses", async () => {
  await withTempDir(async (dir) => {
    const result = runCli(["control-mode", "--project", dir]);
    assert.equal(result.status, 1);
    const err = normalize(result.stderr);
    assert.match(err, /control-mode needs a Legion CLI project first/);
    assert.match(err, /Next: legion-cli init/);
  });
});
