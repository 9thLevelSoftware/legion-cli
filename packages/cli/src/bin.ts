#!/usr/bin/env node

import { runCli } from "./cli.js";
import { writeErr } from "./io.js";

/**
 * `legion` and `legion-cli` both run this file. `legion` also names other tools on many machines:
 * the @9thlevelsoftware/legion plugin installer and the legion-ascended workflow engine. Their first
 * arguments get a clear refusal (exit 2) instead of commander's "unknown command".
 * Verbs Legion CLI also has (plan, review, ship, status, doctor, init, map) stay Legion CLI's.
 */
const INSTALLER_FLAGS = new Set([
  "--claude",
  "--codex",
  "--cursor",
  "--copilot",
  "--gemini",
  "--antigravity",
  "--agy",
  "--kiro",
  "--amazon-q",
  "--windsurf",
  "--opencode",
  "--kilo",
  "--kilo-code",
  "--kilocode",
  "--aider",
  "--uninstall",
  "--update",
  "install",
  "uninstall",
  "add",
  "remove",
  "update",
  "upgrade",
  "plugin",
]);

/** legion-ascended workflow-engine verbs that Legion CLI does not have. */
const ASCENDED_VERBS = new Set([
  "start",
  "explore",
  "build",
  "approve",
  "attest",
  "release",
  "retro",
  "quick",
  "advise",
  "polish",
  "learn",
  "milestone",
  "validate",
  "board",
  "council",
  "portfolio",
  "dev",
]);

function foreignFirstArg(argv: string[]): string | undefined {
  const first = argv[2];
  return first && (INSTALLER_FLAGS.has(first) || ASCENDED_VERBS.has(first)) ? first : undefined;
}

function mcpStdioSession(argv: string[]): boolean {
  const rest = argv.slice(2);
  if (rest.includes("--help") || rest.includes("-h")) return false;
  return rest.includes("mcp");
}

const foreign = foreignFirstArg(process.argv);
if (foreign) {
  writeErr(
    `legion is Legion CLI (same as legion-cli). "${foreign}" belongs to another tool: ` +
      "the plugin installer is npx @9thlevelsoftware/legion --claude (bin legion-plugins); " +
      "the legion-ascended workflow engine has its own legion bin.\n" +
      "Next: legion-cli help --all",
  );
  process.exit(2);
}

const code = await runCli(process.argv);
if (mcpStdioSession(process.argv)) {
  process.exitCode = code;
} else {
  process.exit(code);
}
