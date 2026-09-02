import { writeOut } from "./io.js";

const AVAILABLE = [
  ["status (default)", "Where am I? What next?", "--blockers, --plain"],
  ["init", "Start a product in this folder", "--name, --adapter claude|generic|fake"],
  ["doctor", "Is my laptop ready?", "--metrics"],
  ["ingest <src…>", "Teach Legion CLI from these files/links", "--transcript, --diff, --no-commit"],
  ["wiki trust <page>", "I have read this ingested page; treat it as real", ""],
  ["search <q>", "Search the wiki", "--mentions, --include-untrusted"],
  ["show <page>", "Open one wiki/spec/task page", ""],
  ["brief", "Print what the next agent will see", ""],
  ["mcp", "Read-only stdio MCP server", ""],
  ["intent", "Interview me about the product", "--resume, --done"],
  ["discuss", "Capture decisions before planning", ""],
  ["spec", "Write the short contract + wireframes", "--skip-wireframes"],
  ["spec show", "Show the spec path", ""],
  ["spec approve", "Freeze the spec", "--message"],
  ["spec new", "Start the next increment after ship", ""],
  ["plan", "Break into tasks I can see on the board", ""],
  ["next", "What is unblocked?", ""],
  ["execute [id]", "Do the next ready task", "--fix, --until-blocked"],
  ["verify [id]", "Optional walkthrough notes (not a ship gate)", ""],
  ["review", "Spec-level review; fix tasks mean FAIL and re-review", ""],
  ["qa", "Score the product (when the slice is done)", "--mode full|no-browser"],
  ["qa checklist", "Tick AC items when no browser", "--tick"],
  ["fix <bug>", "Test first (must stay RED), then fix", ""],
  ["ship", "Final human review; stage diff", "--allow-degraded-qa, --pr (needs --commit), --commit"],
  ["abandon", "Stop this spec without shipping", "--message"],
  ["ticket create", "Park extra work", "--parent, --title, --from-agent"],
  ["task amend", "Human changes a file contract", "--allow-deps"],
  ["design-system show", "Show the active design-system package", ""],
  ["design-system install <dir>", "Copy a local design-system directory", "github: rejected"],
  ["design-system import-od <dir>", "One-way OpenDesign importer", ""],
  ["design-system generate", "Generate a design system from a brief", "--name, --work-type, --platforms, --wcag, --brand"],
  ["dashboard", "Open the visual board (viewer)", "--no-open, --port, --expose"],
  ["brownfield", "Audit an existing app (effort 1)", "--effort, --execute, --resume"],
  ["run promote", "Copy brownfield run pages into the wiki", ""],
  ["packet new", "PM/designer request without the DAG", "--title, --request, --requester"],
  ["packet respond", "Spawn tickets from a packet (does not execute)", "--message, --title"],
  ["help", "Commands", "--all"],
] as const;

const V0_SURFACE = [
  ["legion-cli / legion-cli status", "Where am I? What next?", "--blockers, --plain"],
  ["legion-cli init", "Start a product in this folder", "--name, --adapter claude|generic|fake"],
  ["legion-cli doctor", "Is my laptop ready?", "--metrics"],
  ["legion-cli ingest <src…>", "Teach Legion CLI from these files/links", "--transcript, --diff, --no-commit"],
  ["legion-cli wiki trust <page>", "I have read this ingested page; treat it as real", ""],
  ["legion-cli intent", "Interview me about the product", "--resume, --done"],
  ["legion-cli discuss", "Capture decisions before planning", ""],
  ["legion-cli spec", "Write the short contract + wireframes", "--skip-wireframes"],
  ["legion-cli spec show", "Show the spec path", ""],
  ["legion-cli spec approve", "Freeze the spec", "--message"],
  ["legion-cli spec new", "Start the next increment after ship", ""],
  ["legion-cli plan", "Break into tasks I can see on the board", ""],
  ["legion-cli next", "What is unblocked?", ""],
  ["legion-cli execute [id]", "Do the next ready task", "--fix, --until-blocked"],
  ["legion-cli ticket create", "Park extra work", "--parent, --title, --from-agent"],
  ["legion-cli task amend", "Human changes a file contract", "--allow-deps"],
  ["legion-cli verify [id]", "Optional walkthrough notes (not a ship gate)", ""],
  ["legion-cli review", "Spec-level review; fix tasks mean FAIL and re-review", ""],
  ["legion-cli qa", "Score the product (when the slice is done)", "--mode full|no-browser"],
  ["legion-cli qa checklist", "Tick AC items when no browser", ""],
  ["legion-cli fix <bug>", "Test first (must stay RED), then fix", ""],
  ["legion-cli ship", "Final human review; stage diff", "--allow-degraded-qa, --pr, --commit"],
  ["legion-cli dashboard", "Open the visual board (viewer)", "--no-open, --port, --expose"],
  ["legion-cli search <q>", "Search the wiki", "--mentions, --include-untrusted"],
  ["legion-cli show <page>", "Open one wiki/spec/task page", ""],
  ["legion-cli brief", "Print what the next agent will see", ""],
  ["legion-cli assume list", "Open questions that block work", ""],
  ["legion-cli assume answer <id>", "Confirm or reject an assumption", "--status confirmed|rejected"],
  ["legion-cli index rebuild", "Repair search", ""],
  ["legion-cli abandon", "Stop this spec without shipping", "--message"],
  ["legion-cli help", "Commands", "--all"],
] as const;

const V1_SURFACE = [
  ["legion-cli brownfield", "Audit an existing app (effort 1: architecture + code)", "--effort, --execute, --resume"],
  ["legion-cli run promote", "Copy brownfield run pages into the wiki", ""],
  ["legion-cli init --mode brownfield", "Start a brownfield project", ""],
] as const;

function row(cols: readonly string[]): string {
  const [cmd, what, flags] = cols;
  return flags ? `  ${cmd}\n      ${what}  ${flags}` : `  ${cmd}\n      ${what}`;
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
      "Available now:",
      ...AVAILABLE.map(row),
      "",
      "Full v0 command surface:",
      ...V0_SURFACE.map(row),
      "",
      "v1:",
      ...V1_SURFACE.map(row),
    ].join("\n"),
  );
}
