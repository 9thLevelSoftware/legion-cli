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
  ["review", "Spec-level review; new tasks mean FAIL"],
  ["qa", "Score the product"],
  ["ship", "Final human review; stage the diff"],
  ["help --all", "Full command surface"],
] as const;

const LIFECYCLE_CORE = [
  ["init", "Start a product in this folder", `--name, --adapter ${ADAPTER_ID_HELP}`],
  ["intent", "Interview me about the product", "--resume, --done"],
  ["discuss", "Capture decisions before planning", ""],
  ["spec", "Write the short contract + wireframes", "--skip-wireframes"],
  ["spec show", "Show the spec path", ""],
  ["spec approve", "Freeze the spec", "--message"],
  ["spec new", "Start the next increment after ship", ""],
  ["plan", "Break into tasks I can see on the board", "--adapter"],
  ["execute [id]", "Do the next ready task", "--fix, --until-blocked, --adapter"],
  ["verify [id]", "Optional walkthrough notes (not a ship gate)", "--adapter"],
  ["review", "Spec-level review; fix tasks mean FAIL and re-review", "--adapter"],
  ["qa", "Score the product (when the slice is done)", "--mode full|no-browser"],
  ["qa checklist", "Tick AC items when no browser", "--tick"],
  ["ship", "Final human review; stage diff", "--allow-degraded-qa, --pr (needs --commit), --commit"],
] as const;

const ALWAYS_ON = [
  ["status (default)", "Where am I? What next?", "--blockers, --plain"],
  ["doctor", "Is my laptop ready?", "--metrics"],
  ["ingest <src…>", "Teach Legion CLI from these files/links", "--transcript, --diff, --no-commit"],
  ["wiki trust <page>", "I have read this ingested page; treat it as real", ""],
  ["search <q>", "Search the wiki", "--mentions, --include-untrusted"],
  ["show <page>", "Open one wiki/spec/task page", ""],
  ["brief", "Print what the next agent will see", ""],
  ["index rebuild", "Repair search", ""],
  ["help", "Commands", "--all"],
] as const;

const BOARD_EXTRAS = [
  ["next", "What is unblocked?", ""],
  ["ticket create", "Park extra work", "--parent, --title, --from-agent, --adapter, --route"],
  ["task amend", "Human changes a file contract", "--allow-deps, --adapter, --route, --clear-adapter"],
  ["fix <bug>", "Test first (must stay RED), then fix", "--adapter"],
  ["abandon", "Stop this spec without shipping", "--message"],
  ["assume list", "Open questions that block work", ""],
  ["assume answer <id>", "Confirm or reject an assumption", "--status confirmed|rejected"],
] as const;

const SHIPPED_ADJACENT = [
  ["dashboard", "Open the visual board (viewer with optional writes; not the source of truth)", "--no-open, --port, --expose"],
  ["packet new", "PM/designer request without the DAG", "--title, --request, --requester"],
  ["packet respond", "Spawn tickets from a packet (does not execute)", "--message, --title"],
  ["context compact", "Manual compaction of done tasks", ""],
  ["garden", "Stale wiki, orphans, duplicates", ""],
  ["brownfield", "Audit an existing app (effort 1)", "--effort, --execute, --resume"],
  ["run promote", "Copy brownfield run pages into the wiki", ""],
  ["mcp", "Read-only stdio MCP server", ""],
  ["design-system show", "Show the active design-system package", ""],
  ["design-system install <dir>", "Copy a local design-system directory", "github: rejected"],
  ["design-system import-od <dir>", "One-way OpenDesign importer", ""],
  ["design-system generate", "Generate a design system from a brief", "--name, --work-type, --platforms, --wcag, --brand"],
] as const;

function row(cols: readonly string[]): string {
  const [cmd, what, flags] = cols;
  return flags ? `  ${cmd}\n      ${what}  ${flags}` : `  ${cmd}\n      ${what}`;
}

export function formatHelpLayer1(): string {
  const width = Math.max(...LAYER_1.map(([cmd]) => cmd.length));
  const text = [
    "Legion CLI — Product Engineering lifecycle engine",
    "Supported command: pnpm exec legion-cli",
    "Does not register bin legion.",
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
      "Supported command: pnpm exec legion-cli",
      "This engine does not register the legion bin (that is @9thlevelsoftware/legion).",
      "",
      "Global flags: --project <dir>, --json, --yes, --verbose",
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
      "",
      "Later, not this series:",
      "  map, wireframe, skills list|install, serve, control-mode",
      "",
      "Not in this product:",
      "  chat, HTTP model router, bin legion",
    ].join("\n"),
  );
}
