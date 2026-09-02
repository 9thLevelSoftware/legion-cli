#!/usr/bin/env node

import { runCli } from "./cli.js";

function mcpStdioSession(argv: string[]): boolean {
  const rest = argv.slice(2);
  if (rest.includes("--help") || rest.includes("-h")) return false;
  return rest.includes("mcp");
}

const code = await runCli(process.argv);
if (mcpStdioSession(process.argv)) {
  process.exitCode = code;
} else {
  process.exit(code);
}
