import assert from "node:assert/strict";
import test from "node:test";

import { createProgram } from "../dist/cli.js";
import { normalize, runCli } from "./helpers.js";

// `brownfield init` is an alias of bare `brownfield`; help documents it on the `brownfield` row.
const UNLISTED_ALIASES = new Set(["brownfield init"]);

// Group verbs with no row of their own: bare invocation only prints `requires <sub>` + `Next:`
// (cli.ts requireSub), except `design-system`, whose bare form runs `show` (the
// `design-system show` row). Every other registered path, including parents that act on
// their own such as `spec` and `qa`, must have its own row.
const PARENT_ONLY = new Set([
  "wiki",
  "index",
  "assume",
  "packet",
  "ticket",
  "task",
  "run",
  "design-system",
  "skills",
  "context",
]);

/** Every registered command path, e.g. "spec approve", with whether it has subcommands. */
function registeredCommands() {
  const paths = new Map();
  const walk = (cmd, prefix) => {
    for (const sub of cmd.commands) {
      const path = [...prefix, sub.name()];
      paths.set(path.join(" "), { isParent: sub.commands.length > 0 });
      walk(sub, path);
    }
  };
  walk(createProgram(), []);
  return paths;
}

/** "design-system install <dir|…>" -> "design-system install"; "status (default)" -> "status". */
function commandPath(cell) {
  const words = [];
  for (const token of cell.trim().split(/\s+/)) {
    if (!/^[a-z][a-z-]*$/.test(token)) break;
    words.push(token);
  }
  return words.join(" ");
}

/** Rows of `help --all`: a two-space command line followed by a six-space description line. */
function helpAllRows() {
  const result = runCli(["help", "--all"]);
  assert.equal(result.status, 0, result.stderr);
  const lines = normalize(result.stdout).split("\n");
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^ {2}(?! )(.+)$/.exec(lines[i]);
    if (!match) continue;
    const description = /^ {6}(.+)$/.exec(lines[i + 1] ?? "")?.[1] ?? "";
    rows.push({ cell: match[1], path: commandPath(match[1]), description });
  }
  return rows;
}

/** Rows of layer-1 `help`: "<cmd padded>  <what>" lines. */
function helpLayer1Paths() {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  return normalize(result.stdout)
    .split("\n")
    .filter((line) => /^[a-z]/.test(line))
    .map((line) => commandPath(line.split(/\s{2,}/)[0]));
}

function brownfieldSubcommandsListed(rows) {
  const row = rows.find((entry) => entry.path === "brownfield");
  assert.ok(row, "help --all has no brownfield row");
  const list = /then ([a-z|-]+)/.exec(row.description)?.[1];
  assert.ok(list, `brownfield row does not list its subcommands: ${row.description}`);
  return list.split("|").map((sub) => `brownfield ${sub}`);
}

test("every registered command appears in help --all", () => {
  const rows = helpAllRows();
  const listed = new Set([...rows.map((row) => row.path), ...brownfieldSubcommandsListed(rows)]);
  const commands = registeredCommands();
  const missing = [];
  for (const path of commands.keys()) {
    if (UNLISTED_ALIASES.has(path) || PARENT_ONLY.has(path) || listed.has(path)) continue;
    missing.push(path);
  }
  assert.deepEqual(missing, [], `registered but missing from help-all.ts: ${missing.join(", ")}`);
});

test("PARENT_ONLY verbs are registered groups with at least one listed subcommand", () => {
  const rows = helpAllRows();
  const listed = [...rows.map((row) => row.path), ...brownfieldSubcommandsListed(rows)];
  const commands = registeredCommands();
  for (const parent of PARENT_ONLY) {
    assert.equal(commands.get(parent)?.isParent, true, `${parent} is not a registered group command`);
    assert.ok(
      listed.some((entry) => entry.startsWith(`${parent} `)),
      `${parent} has no listed subcommand in help-all.ts`,
    );
  }
});

test("every help --all and layer-1 help entry is a registered command", () => {
  const rows = helpAllRows();
  const commands = registeredCommands();
  const entries = [...rows.map((row) => row.path), ...brownfieldSubcommandsListed(rows), ...helpLayer1Paths()];
  assert.ok(entries.length > 40, `parsed too few help rows (${entries.length}); did the help format change?`);
  const unknown = entries.filter((path) => !commands.has(path));
  assert.deepEqual(unknown, [], `listed in help-all.ts but not registered: ${unknown.join(", ")}`);
});
