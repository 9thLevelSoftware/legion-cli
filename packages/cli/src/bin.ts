#!/usr/bin/env node

import { runCli } from "./cli.js";
import { writeErr } from "./io.js";

/** Sibling installer flags. First user arg only — both npm bins share this file. */
const INSTALLER_FLAGS = new Set([
  "--claude",
  "--cursor",
  "--windsurf",
  "--codex",
  "--gemini",
  "--antigravity",
  "install",
  "plugin",
]);

const INSTALLER_REFUSE =
  "legion is Legion CLI; plugin installer is npx @9thlevelsoftware/legion --claude (bin legion-plugins)";

function mcpStdioSession(argv: string[]): boolean {
  const rest = argv.slice(2);
  if (rest.includes("--help") || rest.includes("-h")) return false;
  return rest.includes("mcp");
}

function installerFlag(argv: string[]): string | undefined {
  const flag = argv[2];
  return flag && INSTALLER_FLAGS.has(flag) ? flag : undefined;
}

if (installerFlag(process.argv)) {
  writeErr(INSTALLER_REFUSE);
  process.exit(2);
}

const code = await runCli(process.argv);
if (mcpStdioSession(process.argv)) {
  process.exitCode = code;
} else {
  process.exit(code);
}
