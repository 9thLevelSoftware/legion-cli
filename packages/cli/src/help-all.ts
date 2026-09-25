import { ADAPTER_ID_HELP } from "@9thlevelsoftware/legion-cli-schema";
import { writeOut } from "./io.js";

const LAYER_1 = [
  ["status (default)", "Where am I? What next?"],
  ["init", "Start a product in this folder"],
  ["doctor", "Is my laptop ready?"],
  ["ingest", "Teach Legion CLI from files/links"],
  ["intent", "Interview me (two questions at a time)"],
  ["discuss", "Capture decisions before planning"],
  ["spec", "Write the short contract + wireframes"],
  ["plan", "Break into tasks I can see on the board"],
  ["execute", "Do the next ready task"],
  ["verify", "Optional walkthrough notes (not a ship gate)"],
  ["review", "Spec-level review; fix tasks or in-place rewrites mean FAIL"],
  ["qa", "Score the product"],
  ["ship", "Final human review; stage the diff"],
  ["help --all", "Full command surface"],
] as const;

const LIFECYCLE_CORE = [
  [
    "init",
    "Start a product in this folder",
    `--name, --adapter ${ADAPTER_ID_HELP}, --mode greenfield|brownfield, --http-base-url, --http-model, --http-api-key-env`,
  ],
  ["intent", "Interview me about the product", "--done"],
  ["discuss", "Capture decisions before planning", ""],
  ["spec", "Write the short contract + wireframes", "--skip-wireframes"],
  ["spec show", "Show the spec path", ""],
  ["spec approve", "Freeze the spec", "--message"],
  ["spec new", "Start the next increment after ship", ""],
  ["plan", "Break into tasks I can see on the board", "--adapter"],
  ["execute [id]", "Do the next ready task", "--fix, --until-blocked, --adapter, --allow-no-sandbox (TTY confirmation)"],
  ["verify [id]", "Optional walkthrough notes (not a ship gate)", "--adapter"],
  ["review", "Spec-level review; fix tasks or in-place rewrites mean FAIL and re-review", "--adapter"],
  ["qa", "Score the product (when the slice is done)", "--mode full|no-browser"],
  ["qa checklist", "Tick AC items when no browser", "--tick"],
  ["ship", "Final human review; stage diff", "--allow-degraded-qa, --pr (needs --commit), --commit"],
] as const;

const ALWAYS_ON = [
  ["status (default)", "Where am I? What next?", "--blockers, --plain"],
  ["doctor", "Is my laptop ready?", "--metrics"],
  ["control-mode [mode]", "Show or set guarded|advisory", ""],
  ["ingest <src…>", "Teach Legion CLI from these files/links", "--transcript, --diff, --no-commit, --distill"],
  ["wiki trust <page>", "I have read this ingested page; treat it as real", ""],
  ["search <q>", "Search the wiki", "--mentions, --include-untrusted"],
  ["show <page>", "Open one wiki/spec/task/map page", ""],
  ["brief", "Print what the next agent will see", ""],
  ["chat", "REPL that routes into engine verbs", "--once, --adapter, --fork"],
  ["index rebuild", "Repair search", ""],
  ["help", "Commands", "--all"],
] as const;

const BOARD_EXTRAS = [
  ["next", "What is unblocked?", ""],
  ["ticket create", "Park extra work", "--parent, --title, --from-agent, --type, --priority, --adapter, --route"],
  ["task amend", "Human changes a file contract", "--allow-deps, --adapter, --route, --clear-adapter, --unblock, --recover"],
  ["undo", "Revert last completed task or Legion commit", "--task"],
  ["recipe list", "List available workflow recipes", ""],
  ["recipe run <name>", "Execute a workflow recipe", "--param"],
  ["repl", "Host-mode interactive REPL (NO SANDBOX)", "--lang node|python"],
  ["fix <bug>", "Test first (must stay RED), then fix", "--adapter, --allow-no-sandbox (TTY confirmation)"],
  ["abandon", "Stop this spec without shipping", "--message"],
  ["assume list", "Open questions that block work", ""],
  ["assume answer <id>", "Confirm or reject an assumption", "--status confirmed|rejected"],
] as const;

const SHIPPED_ADJACENT = [
  ["serve", "Dashboard plus read-only MCP HTTP (MCP HTTP is loopback-only)", "--port, --expose, --no-open, --mcp-http/--no-mcp-http, --webmcp, --token-stdout"],
  ["dashboard", "Open the visual board (read-only viewer; writes are CLI or token-gated HTTP POST (ticket|wikiTrust|qaChecklist); not the source of truth)", "--no-open, --port, --expose"],
  ["packet new", "PM/designer request without the DAG", "--title, --request, --requester"],
  ["packet respond", "Spawn tickets from a packet (does not execute)", "--message, --title, --type, --priority"],
  ["context compact", "Manual compaction of done tasks", ""],
  ["map", "Generate architecture markdown and fingerprints", "--refresh, --lsp, --no-lsp"],
  ["garden", "Stale wiki, orphans, duplicates", ""],
  ["brownfield [context]", "Audit an existing app: init a run, then roster|evidence|merge|review-status|pr-plan|dag|worktree|state|patterns", "--effort 1–5, --execute, --resume, --lsp"],
  [
    "run promote",
    "Copy brownfield run pages into the wiki (untrusted until wiki trust; re-promote overwrites; Next is first page)",
    "--trust",
  ],
  ["mcp", "Read-only stdio MCP server", ""],
  ["design-system show", "Show the active design-system package", ""],
  ["design-system install <dir|github:owner/repo@tag>", "Install a design-system package", "--integrity, --allow-branch"],
  ["design-system import-od <dir>", "One-way OpenDesign importer", ""],
  ["design-system generate", "Generate a design system from a brief", "--name, --work-type, --platforms, --wcag, --brand"],
  ["skills list", "List packaged and overlay skills", ""],
  ["skills show <id>", "Show one packaged or overlay skill", ""],
  ["skills install <dir|github:owner/repo@tag>", "Install a pinned skill overlay", "--unsigned, --skill, --integrity"],
  ["wireframe", "Re-generate HTML wireframes after spec edits", "--restyle, --spawn, --adapter"],
] as const;

const INVOCATION = [
  "Supported commands: pnpm exec legion-cli   |   legion (alias)",
  "Plugin installer: npx @9thlevelsoftware/legion --claude   (bin legion-plugins)",
] as const;

function row(cols: readonly string[]): string {
  const [cmd, what, flags] = cols;
  return flags ? `  ${cmd}\n      ${what}  ${flags}` : `  ${cmd}\n      ${what}`;
}

export function formatHelpLayer1(): string {
  const width = Math.max(...LAYER_1.map(([cmd]) => cmd.length));
  const text = [
    "Legion CLI — Product Engineering lifecycle engine",
    ...INVOCATION,
    "",
    ...LAYER_1.map(([cmd, what]) => `${cmd.padEnd(width)}  ${what}`),
  ].join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function printHelpLayer1(): void {
  writeOut(formatHelpLayer1());
}

export function printHelpAll(): void {
  writeOut(
    [
      "Legion CLI — Product Engineering lifecycle engine",
      ...INVOCATION,
      "",
      "Global flags: --project <dir>, --json, --yes (ignored by intent confirm and ship; discuss refuses), --verbose",
      "",
      "Lifecycle core:",
      ...LIFECYCLE_CORE.map(row),
      "",
      "Always-on operations:",
      ...ALWAYS_ON.map(row),
      "",
      "Board extras:",
      ...BOARD_EXTRAS.map(row),
      "",
      "Shipped adjacent (not the default window):",
      ...SHIPPED_ADJACENT.map(row),
    ].join("\n"),
  );
}
