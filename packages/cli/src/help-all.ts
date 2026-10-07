import { ADAPTER_ID_HELP } from "@9thlevelsoftware/legion-cli-schema";
import { writeOut } from "./io.js";

const LAYER_1 = [
  ["status (default)", "Where am I? What next?"],
  ["init", "Start greenfield or brownfield work"],
  ["spec", "Discuss and write the approved contract"],
  ["plan", "Create and approve the implementation plan"],
  ["execute", "Run approved work to completion or a blocker"],
  ["ship", "Review evidence and deliver the change"],
  ["help --all", "Full command surface"],
] as const;

const LIFECYCLE_CORE = [
  [
    "init",
    "Start a product in this folder",
    `--name, --adapter ${ADAPTER_ID_HELP}, --mode greenfield|brownfield, --brownfield-goal change|audit, --generic-binary, --generic-args, --http-base-url, --http-model, --http-api-key-env, --http-allow-loopback, --acp-command, --acp-args`,
  ],
  ["intent", "Interview me about the product", "--done, --guidance guided|balanced|direct"],
  ["discuss", "Capture decisions before planning", ""],
  ["spec", "Discuss, challenge assumptions, and write the short contract", "--wireframes (optional), --manual-review (automation fallback), --guidance guided|balanced|direct, --from <local-file>, --explore, --input <source-path> (repeatable)"],
  ["spec show", "Show the spec path", ""],
  ["spec approve", "Freeze the spec", "--message"],
  ["spec new", "Start the next increment after ship", ""],
  ["plan", "Break approved work into tasks", "--adapter, --profile, --compare, --design-stage, --strategy outcomes|risk-first|expand-contract|custom, --rationale, --granularity coarse|balanced|fine, --input <source-path> (repeatable)"],
  ["plan approve", "Approve the plan and its checks", "--check <command...>, --assurance <yaml-file>|--assurance-off"],
  ["plan acceptance", "Record manual acceptance evidence", "--pass|--fail|--not-applicable <ids...>, --note, --method, --evidence <local-path|report:id|external:id|urn:id|https-url>"],
  ["plan evidence", "Inspect requirement coverage and component evidence", "--json"],
  ["plan impact", "Inspect changed bindings and exact rerun/reuse reasons", "--json"],
  ["execute [id]", "Run approved work to completion or a blocker", "--step, --retry, --resume <runId>, --until-blocked, --jobs 1-4, --fix, --adapter, --profile, --allow-no-sandbox (TTY confirmation)"],
  ["execute approve-action", "Approve one exact pending governed effect", "--run, --action, --value-digest, --sink, --reason"],
  ["verify [id]", "Optional agent walkthrough (not a ship gate; notes not retained yet)", "--adapter, --profile"],
  ["review", "Spec-level review; fix tasks or in-place rewrites mean FAIL and re-review; PASS needs exit 0 and notes", "--adapter, --profile"],
  ["qa", "Score the product (when the slice is done)", "--mode full|no-browser"],
  ["qa checklist", "Tick AC items when no browser", "--tick"],
  ["ship", "Final human review; stage diff", "--allow-degraded-qa, --pr (needs --commit), --commit, --bundle <directory>"],
  ["ship export", "Export a completed historical delivery snapshot locally without recapturing project state", "--snapshot <id>, --out <directory>, --json"],
  ["ship verify <bundle>", "Verify bundle integrity, authenticity, supplied content, and claims without project state", "--require, --trust-policy, --source, --artifacts, --expect-approval, --json"],
  ["ship sign <bundle>", "Sign a prepared delivery bundle offline with an external Ed25519 key; encrypted keys prompt for a hidden TTY passphrase", "--key <path>, --project, --json"],
] as const;

const ALWAYS_ON = [
  ["status (default)", "Where am I? What next?", "--blockers, --plain"],
  ["doctor", "Is my laptop ready?", "--metrics, --rebaseline-audit"],
  ["control-mode [mode]", "Show or set guarded|advisory", ""],
  ["ingest <src…>", "Teach Legion CLI from these files/links", "--transcript, --diff, --no-commit, --distill"],
  ["wiki trust <page>", "I have read this ingested page; treat it as real", ""],
  ["search <q>", "Search the wiki", "--mentions, --include-untrusted, --limit <n>"],
  ["show <page>", "Open one wiki/spec/task/map page", ""],
  ["brief", "Print what the next agent will see", ""],
  ["chat", "REPL that routes into engine verbs", "--once, --adapter, --profile, --fork"],
  ["index rebuild", "Repair search", ""],
  ["help", "Commands", "--all"],
] as const;

const BOARD_EXTRAS = [
  ["next", "What is unblocked?", ""],
  ["ticket create", "Park extra work", "--parent, --title, --from-agent, --type, --priority, --adapter, --route, --profile"],
  ["task amend", "Human changes a file contract", "--allow-deps, --adapter, --route, --profile, --clear-adapter, --clear-profile, --unblock, --recover"],
  ["undo", "Revert last completed task or Legion commit", "--task"],
  ["recipe list", "List available workflow recipes", ""],
  ["recipe run <name>", "Execute a workflow recipe", "--param"],
  ["repl", "Host-mode interactive REPL (NO SANDBOX)", "--lang node|python"],
  ["fix <bug>", "Test first (must stay RED), then fix", "--adapter, --profile, --allow-no-sandbox (TTY confirmation)"],
  ["abandon", "Stop this spec without shipping", "--message"],
  ["assume list", "Open questions that block work", ""],
  ["assume answer <id>", "Confirm or reject an assumption", "--status confirmed|rejected"],
] as const;

const SHIPPED_ADJACENT = [
  ["serve", "Dashboard plus read-only MCP HTTP (MCP HTTP is loopback-only)", "--port, --expose (needs --no-mcp-http: MCP HTTP is loopback-only), --no-open, --mcp-http/--no-mcp-http, --webmcp, --token-stdout"],
  ["dashboard", "Open the visual board (read-only viewer; writes are CLI or token-gated HTTP POST (ticket|wikiTrust|qaChecklist); not the source of truth)", "--no-open, --port, --expose, --webmcp, --token-stdout"],
  ["packet new", "PM/designer request without the DAG", "--title, --request, --requester"],
  ["packet respond", "Spawn tickets from a packet (does not execute)", "--message, --title, --type, --priority"],
  ["context compact", "Manual compaction of done tasks", ""],
  ["context trace", "Governance epochs, trace status, and the next command (read-only)", "--json"],
  ["context trace validate", "Validate the governance trace; exit 0 only when valid or not adopted", "--json"],
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
  ["skills install <dir|github:owner/repo@tag>", "Install a pinned skill or extension overlay", "--unsigned, --skill, --extension, --integrity"],
  ["skills run <extension:id>", "Run an extension evidence job or component validator", "--profile, --validator-input"],
  ["wireframe", "Re-generate HTML wireframes after spec edits", "--restyle, --spawn, --adapter, --profile"],
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
