import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Help, Option } from "commander";
import { HINT, LegionRefuseError, refuse } from "@9thlevelsoftware/legion-cli-core";
import { DesignSystemError } from "@9thlevelsoftware/legion-cli-design-system";
import { EngineLockedError } from "@9thlevelsoftware/legion-cli-persist";
import { ADAPTER_ID_HELP } from "@9thlevelsoftware/legion-cli-schema";
import { runAbandon } from "./abandon.js";
import { runAssumeAnswer, runAssumeList } from "./assume.js";
import { runBrief } from "./brief.js";
import {
  runBrownfield,
  runBrownfieldDag,
  runBrownfieldEvidence,
  runBrownfieldMerge,
  runBrownfieldPatterns,
  runBrownfieldPrPlan,
  runBrownfieldReviewStatus,
  runBrownfieldRoster,
  runBrownfieldState,
  runBrownfieldWorktree,
  type ReviewStatusFlags,
} from "./brownfield.js";
import { runChat } from "./chat.js";
import { runDashboard } from "./dashboard.js";
import { runServe } from "./serve.js";
import { runDiscuss } from "./discuss.js";
import { runControlMode } from "./control-mode.js";
import { runDoctor } from "./doctor.js";
import { runExecute } from "./execute.js";
import { runFix } from "./fix.js";
import { formatHelpLayer1, printHelpAll, printHelpLayer1 } from "./help-all.js";
import { runIndexRebuild } from "./index-rebuild.js";
import { runIngest } from "./ingest.js";
import { runMap } from "./map.js";
import { runInit } from "./init.js";
import { runIntent } from "./intent.js";
import { printRefuse, resolveOpts, writeErr } from "./io.js";
import {
  runDesignSystemGenerate,
  runDesignSystemImportOd,
  runDesignSystemInstall,
  runDesignSystemShow,
} from "./design-system.js";
import { runMcp } from "./mcp.js";
import { runNextTasks } from "./next-tasks.js";
import { runPacketNew, runPacketRespond } from "./packet.js";
import { runPlan } from "./plan.js";
import { runPromote } from "./run.js";
import { runQa, runQaChecklist } from "./qa.js";
import { runReview } from "./review.js";
import { runSearch } from "./search.js";
import { runShip } from "./ship.js";
import { runShow } from "./show.js";
import { runSpecApprove, runSpecDraft, runSpecNew, runSpecShow } from "./spec.js";
import { runStatus } from "./status.js";
import { runTaskAmend, runTaskRetry } from "./task.js";
import { runTicketCreate } from "./ticket.js";
import { runVerify } from "./verify.js";
import { runContextCompact } from "./context.js";
import { runGarden } from "./garden.js";
import { runWikiTrust } from "./wiki.js";
import { runSkillsInstall, runSkillsList, runSkillsShow } from "./skills.js";
import { runWireframe } from "./wireframe.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string };

function addGlobalOptions(cmd: Command): Command {
  return cmd
    .option("--project <dir>", "project directory")
    .option("--json", "machine-readable output")
    .option("--yes", "ignored by intent confirm and ship; discuss refuses")
    .option("--verbose", "verbose logging");
}

function addStatusOptions(cmd: Command): Command {
  return cmd.option("--blockers", "list blocked work").option("--plain", "compact output");
}

function printUnknownCommand(name: string): void {
  writeErr(`unknown command '${name}'\n(run legion-cli help --all)`);
}

function requireSub(verb: string, sub: string, next: string): () => void {
  return () => {
    writeErr(`${verb} requires ${sub}\nNext: ${next}`);
    process.exitCode = 1;
  };
}

const builtinHelp = new Help();

export function createProgram(): Command {
  const program = new Command();
  addGlobalOptions(program);
  addStatusOptions(program);
  program
    .name("legion-cli")
    .description(
      "Product Engineering lifecycle engine.\nSupported commands: pnpm exec legion-cli   |   legion (alias)\nPlugin installer: npx @9thlevelsoftware/legion --claude   (bin legion-plugins)",
    )
    .version(pkg.version)
    .showSuggestionAfterError(false)
    .showHelpAfterError(false)
    .exitOverride()
    .allowExcessArguments(true)
    .configureHelp({
      formatHelp: (cmd, helper) =>
        cmd.parent == null ? formatHelpLayer1() : builtinHelp.formatHelp(cmd, helper),
    })
    .configureOutput({
      outputError: (str, write) => {
        const match = /unknown command '([^']+)'/.exec(str);
        if (match) {
          printUnknownCommand(match[1]);
          return;
        }
        write(str);
      },
    })
    .action(async (_opts, cmd: Command) => {
      const extra = cmd.args.filter((arg) => arg.length > 0);
      if (extra.length > 0) {
        printUnknownCommand(extra[0]);
        process.exitCode = 1;
        return;
      }
      const code = await runStatus(resolveOpts(cmd));
      process.exitCode = code;
    });

  addStatusOptions(addGlobalOptions(program.command("status").description("Where am I? What next?")))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runStatus(resolveOpts(cmd));
      process.exitCode = code;
    });

  addGlobalOptions(program.command("init").description("Start a product in this folder"))
    .option("--name <name>", "product name")
    .option("--adapter <id>", `${ADAPTER_ID_HELP} (required)`)
    .option("--mode <mode>", "greenfield or brownfield", "greenfield")
    .option("--generic-binary <bin>", "binary when --adapter generic")
    .option("--generic-args <args...>", "args when --adapter generic")
    .option("--http-base-url <url>", "OpenAI-compat base URL when --adapter http")
    .option("--http-model <id>", "model id when --adapter http")
    .option("--http-api-key-env <ENV>", "env var holding the API key when --adapter http")
    .option("--http-allow-loopback", "allow 127.0.0.1/localhost baseUrl when --adapter http")
    .action(async (opts, cmd: Command) => {
      const flags = opts as {
        name?: string;
        adapter?: string;
        mode?: string;
        genericBinary?: string;
        genericArgs?: string[];
        httpBaseUrl?: string;
        httpModel?: string;
        httpApiKeyEnv?: string;
        httpAllowLoopback?: boolean;
      };
      const code = await runInit(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("doctor").description("Is my laptop ready?"))
    .option("--metrics", "local-only audit metrics (never phones home)")
    .option("--clear-stale-run", "replay and clear a crashed run that is freezing writes")
    .action(async (opts, cmd: Command) => {
      const flags = opts as { metrics?: boolean; clearStaleRun?: boolean };
      const code = await runDoctor(resolveOpts(cmd), {
        metrics: Boolean(flags.metrics),
        clearStaleRun: Boolean(flags.clearStaleRun),
      });
      process.exitCode = code;
    });

  addGlobalOptions(program.command("control-mode").description("Show or set guarded|surgical|advisory"))
    .argument("[mode]", "guarded | surgical | advisory")
    .allowExcessArguments(false)
    .action(async (mode: string | undefined, _opts, cmd: Command) => {
      const code = await runControlMode(resolveOpts(cmd), mode);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("ingest").description("Teach Legion CLI from these files/links"))
    .argument("[sources...]", "files, directories, or https URLs")
    .option("--transcript <path>", "ingest an agent transcript")
    .option("--diff <range>", "ingest a git diff range")
    .option("--no-commit", "skip auto-commit of wiki pages")
    .option("--distill", "optional ingest skill distill (still untrusted)")
    .action(async (sources: string[], opts, cmd: Command) => {
      const flags = opts as { transcript?: string; diff?: string; commit?: boolean; distill?: boolean };
      const code = await runIngest(resolveOpts(cmd), sources, flags);
      process.exitCode = code;
    });

  const wiki = addGlobalOptions(program.command("wiki").description("Wiki operations"));
  wiki.allowExcessArguments(false).action(requireSub("wiki", "trust", "legion-cli wiki trust <page>"));
  addGlobalOptions(wiki.command("trust").description("I have read this ingested page; treat it as real"))
    .argument("<page>", "wiki page id or path")
    .action(async (page: string, _opts, cmd: Command) => {
      const code = await runWikiTrust(resolveOpts(cmd), page);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("search").description("Search the wiki"))
    .argument("<query>", "keyword query")
    .option("--include-untrusted", "search untrusted bodies")
    .option("--mentions", "pages that wikilink to this page")
    .action(async (query: string, opts, cmd: Command) => {
      const flags = opts as { includeUntrusted?: boolean; mentions?: boolean };
      const code = await runSearch(resolveOpts(cmd), query, flags);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("show").description("Open one wiki/spec/task/map page"))
    .argument("<page>", "wiki page, spec, task, or map")
    .action(async (page: string, _opts, cmd: Command) => {
      const code = await runShow(resolveOpts(cmd), page);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("brief").description("Print what the next agent will see")).action(
    async (_opts, cmd: Command) => {
      const code = await runBrief(resolveOpts(cmd));
      process.exitCode = code;
    },
  );

  addGlobalOptions(program.command("chat").description("REPL that routes into engine verbs"))
    .option("--once <utterance>", "one turn, then exit")
    .option("--adapter <id>", ADAPTER_ID_HELP)
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { once?: string; adapter?: string };
      const code = await runChat(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  const index = addGlobalOptions(program.command("index").description("Repair search"));
  index.allowExcessArguments(false).action(requireSub("index", "rebuild", "legion-cli index rebuild"));
  addGlobalOptions(index.command("rebuild").description("Repair search"))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runIndexRebuild(resolveOpts(cmd));
      process.exitCode = code;
    });

  addGlobalOptions(program.command("mcp").description("Read-only stdio MCP server"))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runMcp(resolveOpts(cmd));
      process.exitCode = code;
    });

  addGlobalOptions(program.command("intent").description("Interview me about the product"))
    .option("--done", "finish after round 2 (still requires confirm)")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { done?: boolean };
      const code = await runIntent(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("discuss").description("Capture decisions before planning"))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runDiscuss(resolveOpts(cmd));
      process.exitCode = code;
    });

  const spec = addGlobalOptions(program.command("spec").description("Write the short contract + wireframes"))
    .option("--skip-wireframes", "skip HTML wireframes (pre-approve only)")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { skipWireframes?: boolean };
      const code = await runSpecDraft(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  addGlobalOptions(spec.command("show").description("Show the spec path"))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runSpecShow(resolveOpts(cmd));
      process.exitCode = code;
    });

  addGlobalOptions(spec.command("approve").description("Freeze the spec"))
    .option("--message <message>", "note stored with the frozen spec")
    .option("--skip-wireframes", "refused: pre-approve only")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { message?: string; skipWireframes?: boolean };
      const inherited = cmd.optsWithGlobals() as { skipWireframes?: boolean };
      const code = await runSpecApprove(resolveOpts(cmd), {
        ...flags,
        skipWireframes: Boolean(flags.skipWireframes || inherited.skipWireframes),
      });
      process.exitCode = code;
    });

  addGlobalOptions(spec.command("new").description("Start the next increment after ship"))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runSpecNew(resolveOpts(cmd));
      process.exitCode = code;
    });

  addGlobalOptions(program.command("wireframe").description("Re-generate HTML wireframes after spec edits"))
    .option("--restyle", "frozen spec: CSS only")
    .option("--spawn", "optional SkillId wireframe rewrite of inner markup")
    .option("--adapter <id>", ADAPTER_ID_HELP)
    .option("--skip-palette-check", "refused: palettePresent stays hard")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { restyle?: boolean; spawn?: boolean; adapter?: string; skipPaletteCheck?: boolean };
      if (flags.skipPaletteCheck) {
        refuse("palettePresent stays hard until --restyle with an active package", HINT.wireframe);
      }
      const code = await runWireframe(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("plan").description("Break into tasks I can see on the board"))
    .option("--adapter <id>", ADAPTER_ID_HELP)
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { adapter?: string };
      const code = await runPlan(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("next").description("What is unblocked?"))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runNextTasks(resolveOpts(cmd));
      process.exitCode = code;
    });

  addGlobalOptions(program.command("execute").description("Do the next ready task"))
    .argument("[id]", "task id")
    .option("--until-blocked", "loop until no ready task remains; blocked tasks continue, incidents stop")
    .option("--fix", "fix-run prompt (keep reproducing tests)")
    .option("--adapter <id>", ADAPTER_ID_HELP)
    .option("--allow-no-sandbox", "TTY gate to run execute on a copy jail")
    .allowExcessArguments(false)
    .action(async (id: string | undefined, opts, cmd: Command) => {
      const flags = opts as { untilBlocked?: boolean; fix?: boolean; adapter?: string; allowNoSandbox?: boolean };
      const code = await runExecute(resolveOpts(cmd), {
        id,
        untilBlocked: Boolean(flags.untilBlocked),
        fix: Boolean(flags.fix),
        adapter: flags.adapter,
        allowNoSandbox: Boolean(flags.allowNoSandbox),
      });
      process.exitCode = code;
    });


  addGlobalOptions(program.command("verify").description("Optional walkthrough notes (not a ship gate)"))
    .argument("[id]", "task id")
    .option("--adapter <id>", ADAPTER_ID_HELP)
    .allowExcessArguments(false)
    .action(async (id: string | undefined, opts, cmd: Command) => {
      const flags = opts as { adapter?: string };
      const code = await runVerify(resolveOpts(cmd), { id, adapter: flags.adapter });
      process.exitCode = code;
    });

  addGlobalOptions(
    program.command("review").description("Spec-level review; fix tasks or in-place rewrites mean FAIL and re-review"),
  )
    .option("--adapter <id>", ADAPTER_ID_HELP)
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { adapter?: string };
      const code = await runReview(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  const qa = addGlobalOptions(program.command("qa").description("Score the product (when the slice is done)"))
    .option("--mode <mode>", "full | no-browser")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { mode?: string };
      const code = await runQa(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  addGlobalOptions(qa.command("checklist").description("Tick AC items when no browser"))
    .option("--tick <ids...>", "acceptance criterion ids to tick")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { tick?: string[] };
      const code = await runQaChecklist(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("fix").description("Test first (must stay RED), then fix"))
    .argument("<bug...>", "bug to reproduce then fix")
    .option("--adapter <id>", ADAPTER_ID_HELP)
    .option("--allow-no-sandbox", "TTY gate to run execute on a copy jail")
    .allowExcessArguments(false)
    .action(async (bug: string[], opts, cmd: Command) => {
      const flags = opts as { adapter?: string; allowNoSandbox?: boolean };
      const code = await runFix(resolveOpts(cmd), bug.join(" "), flags);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("ship").description("Final human review; stage diff"))
    .option("--allow-degraded-qa", "ship after no-browser QA")
    .option("--pr", "create a GitHub PR with gh (requires --commit)")
    .option("--commit", "create the git commit after Y/n")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { allowDegradedQa?: boolean; pr?: boolean; commit?: boolean };
      const code = await runShip(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("abandon").description("Stop this spec without shipping"))
    .option("--message <message>", "why this spec is abandoned")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { message?: string };
      const code = await runAbandon(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  const assume = addGlobalOptions(program.command("assume").description("Open questions that block work"));
  assume.allowExcessArguments(false).action(requireSub("assume", "list or answer", "legion-cli assume list"));
  addGlobalOptions(assume.command("list").description("Open questions that block work"))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runAssumeList(resolveOpts(cmd));
      process.exitCode = code;
    });
  addGlobalOptions(assume.command("answer").description("Confirm or reject an assumption"))
    .argument("<id>", "assumption id")
    .requiredOption("--status <status>", "confirmed | rejected")
    .allowExcessArguments(false)
    .action(async (id: string, opts, cmd: Command) => {
      const flags = opts as { status?: string };
      const code = await runAssumeAnswer(resolveOpts(cmd), id, flags);
      process.exitCode = code;
    });

  addGlobalOptions(
    program
      .command("serve")
      .description("Dashboard plus read-only MCP HTTP"),
  )
    .option("--no-open", "do not open a browser")
    .option("--port <port>", "port (default 7420)")
    .option("--expose", "bind 0.0.0.0 (warning)")
    .option("--mcp-http", "read-only MCP HTTP at /mcp (default on)")
    .option("--no-mcp-http", "disable MCP HTTP at /mcp")
    .option("--webmcp", "process-level flags.webmcp for this process")
    .option("--token-stdout", "print the write token on stdout")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as {
        open?: boolean;
        port?: string;
        expose?: boolean;
        mcpHttp?: boolean;
        webmcp?: boolean;
        tokenStdout?: boolean;
      };
      const code = await runServe(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("dashboard").description("Open the visual board (read-only viewer; writes are CLI or token-gated HTTP POST (ticket|wikiTrust|qaChecklist); not the source of truth)"))
    .option("--no-open", "do not open a browser")
    .option("--port <port>", "port (default 7420)")
    .option("--expose", "bind 0.0.0.0 (warning)")
    .option("--webmcp", "process-level flags.webmcp for this process")
    .option("--token-stdout", "print the write token on stdout")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as {
        open?: boolean;
        port?: string;
        expose?: boolean;
        webmcp?: boolean;
        tokenStdout?: boolean;
      };
      const code = await runDashboard(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  const packet = addGlobalOptions(program.command("packet").description("PM/designer request without the DAG"));
  packet
    .allowExcessArguments(false)
    .action(requireSub("packet", "new or respond", "legion-cli packet new --title <title>"));
  addGlobalOptions(packet.command("new").description("File a PM/designer request (review packet back)"))
    .requiredOption("--title <title>", "request title")
    .option("--request <text>", "request body")
    .option("--requester <who>", "pm | designer | human")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { title?: string; request?: string; requester?: string };
      const code = await runPacketNew(resolveOpts(cmd), flags);
      process.exitCode = code;
    });
  addGlobalOptions(packet.command("respond").description("Spawn tickets from a packet (does not execute)"))
    .argument("<id>", "packet id")
    .option("--message <message>", "response written into the packet")
    .option("--title <title>", "ticket title (defaults to packet title)")
    .option("--type <type>", "feature | fix | bug")
    .option("--priority <priority>", "P0 | P1 | P2")
    .allowExcessArguments(false)
    .action(async (id: string, opts, cmd: Command) => {
      const flags = opts as { message?: string; title?: string; type?: string; priority?: string };
      const code = await runPacketRespond(resolveOpts(cmd), id, flags);
      process.exitCode = code;
    });

  const ticket = addGlobalOptions(program.command("ticket").description("Park extra work"));
  ticket
    .allowExcessArguments(false)
    .action(requireSub("ticket", "create", "legion-cli ticket create --title <title>"));
  addGlobalOptions(ticket.command("create").description("Park extra work as a linked ticket"))
    .requiredOption("--title <title>", "ticket title")
    .option("--parent <id>", "parent task id")
    .option("--from-agent", "filed from adapter extra.json")
    .option("--type <type>", "feature | fix | bug")
    .option("--priority <priority>", "P0 | P1 | P2")
    .option("--adapter <id>", ADAPTER_ID_HELP)
    .option("--route <name>", "named adapter route (expanded at write)")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as {
        title?: string;
        parent?: string;
        fromAgent?: boolean;
        type?: string;
        priority?: string;
        adapter?: string;
        route?: string;
      };
      const code = await runTicketCreate(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  const task = addGlobalOptions(program.command("task").description("Task file contracts"));
  task.allowExcessArguments(false).action(requireSub("task", "amend", "legion-cli task amend <id>"));
  addGlobalOptions(task.command("amend").description("Human changes a file contract"))
    .argument("<id>", "task id")
    .option("--files-allowed <paths...>", "concrete POSIX paths")
    .option("--verification-commands <cmds...>", "in-process verification commands")
    .option("--expected-artifacts <paths...>", "expected artifact paths")
    .option("--blocked-by <ids...>", "dependency task ids")
    .option("--blocks <ids...>", "downstream task ids")
    .option("--allow-deps", "allow changing blockedBy/blocks")
    .option("--adapter <id>", ADAPTER_ID_HELP)
    .option("--route <name>", "named adapter route (expanded at write)")
    .option("--clear-adapter", "omit Task.adapter")
    .allowExcessArguments(false)
    .action(async (id: string, opts, cmd: Command) => {
      const flags = opts as {
        filesAllowed?: string[];
        verificationCommands?: string[];
        expectedArtifacts?: string[];
        blockedBy?: string[];
        blocks?: string[];
        allowDeps?: boolean;
        adapter?: string;
        route?: string;
        clearAdapter?: boolean;
      };
      const code = await runTaskAmend(resolveOpts(cmd), id, flags);
      process.exitCode = code;
    });
  addGlobalOptions(task.command("retry").description("Move a blocked task back to ready"))
    .argument("<id>", "task id")
    .allowExcessArguments(false)
    .action(async (id: string, _opts, cmd: Command) => {
      const code = await runTaskRetry(resolveOpts(cmd), id);
      process.exitCode = code;
    });

  const brownfieldInitAction = async (context: string[], _opts: unknown, cmd: Command) => {
    // The parent `brownfield` also declares these flags, and commander lets it consume them
    // even after the `init` subcommand name, so read them merged.
    const flags = cmd.optsWithGlobals() as {
      effort?: string;
      execute?: boolean;
      resume?: string;
      runId?: string;
      lsp?: boolean;
    };
    const code = await runBrownfield(resolveOpts(cmd), {
      effort: flags.effort,
      execute: Boolean(flags.execute),
      resume: flags.resume,
      runId: flags.runId,
      lsp: Boolean(flags.lsp),
      context,
    });
    process.exitCode = code;
  };
  const brownfield = addGlobalOptions(
    program
      .command("brownfield")
      .description(
        "Audit an existing app (effort 1–5). The orchestrating agent does judgment; these subcommands keep the books",
      ),
  )
    .argument("[context...]", "scope notes (quote them, or use `brownfield init`, if they start with a subcommand name)")
    .option("--effort <n>", "analysis rigor 1–5 (default 2)")
    .option("--execute", "plan to implement the reviewed PR plan as per-PR git worktrees")
    .option("--lsp", "require a language server for the codebase map init runs (default: auto)")
    .option("--resume <id>", "show a run's state and where to continue")
    .addOption(new Option("--run-id <id>", "fixed 8-hex run id").hideHelp())
    .allowExcessArguments(false)
    .action(brownfieldInitAction);
  addGlobalOptions(brownfield.command("init").description("Start a brownfield run (same as bare brownfield)"))
    .argument("[context...]", "scope notes")
    .option("--effort <n>", "analysis rigor 1–5 (default 2)")
    .option("--execute", "plan to implement the reviewed PR plan as per-PR git worktrees")
    .option("--lsp", "require a language server for the codebase map init runs (default: auto)")
    .addOption(new Option("--run-id <id>", "fixed 8-hex run id").hideHelp())
    .allowExcessArguments(false)
    .action(brownfieldInitAction);
  addGlobalOptions(brownfield.command("state").description("Show or set run state (key=value; meta.<key>=<json>)"))
    .argument("<id>", "run id")
    .argument("[pairs...]", "key=value updates")
    .action(async (id: string, pairs: string[], _opts, cmd: Command) => {
      process.exitCode = await runBrownfieldState(resolveOpts(cmd), id, pairs);
    });
  addGlobalOptions(brownfield.command("roster").description("Compute specialists for this run's effort and signals"))
    .argument("<id>", "run id")
    .allowExcessArguments(false)
    .action(async (id: string, _opts, cmd: Command) => {
      process.exitCode = await runBrownfieldRoster(resolveOpts(cmd), id);
    });
  addGlobalOptions(
    brownfield.command("evidence").description("Collect deterministic test and secret evidence under evidence/"),
  )
    .argument("<id>", "run id")
    .option("--skip-audit", "do not run pnpm/npm audit")
    .allowExcessArguments(false)
    .action(async (id: string, opts, cmd: Command) => {
      process.exitCode = await runBrownfieldEvidence(resolveOpts(cmd), id, opts as { skipAudit?: boolean });
    });
  addGlobalOptions(
    brownfield.command("merge").description("Merge analysis/*.md into findings.md and assumptions.md"),
  )
    .argument("<id>", "run id")
    .allowExcessArguments(false)
    .action(async (id: string, _opts, cmd: Command) => {
      process.exitCode = await runBrownfieldMerge(resolveOpts(cmd), id);
    });
  addGlobalOptions(
    brownfield.command("review-status").description("Verdict for a review file: pass | pass-with-minor | revise | escalate"),
  )
    .argument("<id>", "run id")
    .argument("[file]", "run-relative review file (default reviews/design-review.md)")
    .option("--previous <file>", "run-relative snapshot to detect reopened wontfix items (default <file>.prev.md)")
    .option("--strict", "gate on every severity, not just critical/major")
    .option("--snapshot", "copy the review file to <file>.prev.md after computing the verdict")
    .allowExcessArguments(false)
    .action(async (id: string, file: string | undefined, opts, cmd: Command) => {
      process.exitCode = await runBrownfieldReviewStatus(resolveOpts(cmd), id, file, opts as ReviewStatusFlags);
    });
  addGlobalOptions(brownfield.command("pr-plan").description("Parse design.md '## PR Plan' into dag.json"))
    .argument("<id>", "run id")
    .option("--force", "rebuild dag.json even when nodes have progress (resets every node to pending)")
    .allowExcessArguments(false)
    .action(async (id: string, opts, cmd: Command) => {
      process.exitCode = await runBrownfieldPrPlan(resolveOpts(cmd), id, opts as { force?: boolean });
    });
  addGlobalOptions(brownfield.command("dag").description("Show PR DAG progress; update one node with key=value"))
    .argument("<id>", "run id")
    .argument("[node]", "node id, e.g. pr-2")
    .argument("[pairs...]", "status=… commit=… agentId=… reviewRounds=… error=…")
    .action(async (id: string, node: string | undefined, pairs: string[], _opts, cmd: Command) => {
      process.exitCode = await runBrownfieldDag(resolveOpts(cmd), id, node, pairs);
    });
  addGlobalOptions(
    brownfield.command("worktree").description("Create (or --remove) the isolated worktree for one PR node"),
  )
    .argument("<id>", "run id")
    .argument("<node>", "node id, e.g. pr-1")
    .option("--remove", "remove the worktree (the branch is kept)")
    .option("--force", "with --remove: discard uncommitted changes in the worktree")
    .allowExcessArguments(false)
    .action(async (id: string, node: string, opts, cmd: Command) => {
      process.exitCode = await runBrownfieldWorktree(resolveOpts(cmd), id, node, opts as { remove?: boolean; force?: boolean });
    });
  addGlobalOptions(brownfield.command("patterns").description("Record or list cross-run lessons for this repo"))
    .option("--add <lessons...>", "codebase-agnostic lessons to record")
    .option("--top <n>", "how many to list (default 10)")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      process.exitCode = await runBrownfieldPatterns(resolveOpts(cmd), opts as { add?: string[]; top?: string });
    });

  const run = addGlobalOptions(program.command("run").description("Brownfield run artifacts"));
  run.allowExcessArguments(false).action(requireSub("run", "promote", "legion-cli run promote <id>"));
  addGlobalOptions(
    run
      .command("promote")
      .description(
        "Copy brownfield run pages into the wiki (untrusted until wiki trust; re-promote overwrites; Next is first page)",
      ),
  )
    .argument("<id>", "brownfield run id")
    .option("--trust", "explicit human gate: mark promoted pages reviewed (default untrusted; --yes does not review)")
    .allowExcessArguments(false)
    .action(async (id: string, opts, cmd: Command) => {
      const flags = opts as { trust?: boolean };
      const code = await runPromote(resolveOpts(cmd), id, flags);
      process.exitCode = code;
    });

  const designSystem = addGlobalOptions(
    program.command("design-system").description("Show, install, import, or generate a design-system package"),
  )
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runDesignSystemShow(resolveOpts(cmd));
      process.exitCode = code;
    });

  addGlobalOptions(designSystem.command("show").description("Show the active design-system package"))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runDesignSystemShow(resolveOpts(cmd));
      process.exitCode = code;
    });

  addGlobalOptions(designSystem.command("install").description("Install a local directory or github:owner/repo@tag package"))
    .argument("<source>", "local directory or github:owner/repo@tag")
    .option("--integrity <sha256>", "pin as sha256:<hex>")
    .option("--allow-branch", "fetch refs/heads instead of refs/tags (TTY confirmation)")
    .allowExcessArguments(false)
    .action(async (source: string, opts, cmd: Command) => {
      const flags = opts as { integrity?: string; allowBranch?: boolean };
      const code = await runDesignSystemInstall(resolveOpts(cmd), source, flags);
      process.exitCode = code;
    });

  addGlobalOptions(designSystem.command("import-od").description("One-way OpenDesign importer"))
    .argument("<dir>", "OpenDesign folder with od-design-system-project/v1")
    .allowExcessArguments(false)
    .action(async (dir: string, _opts, cmd: Command) => {
      const code = await runDesignSystemImportOd(resolveOpts(cmd), dir);
      process.exitCode = code;
    });

  addGlobalOptions(designSystem.command("generate").description("Generate a design system from a brief"))
    .option("--name <name>", "package name")
    .option("--work-type <type>", "work type")
    .option("--platforms <platforms>", "phone, desktop, or both")
    .option("--wcag <level>", "A | AA | AAA")
    .option("--brand <path>", "brand file path or none")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as {
        name?: string;
        workType?: string;
        platforms?: string;
        wcag?: string;
        brand?: string;
      };
      const code = await runDesignSystemGenerate(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("garden").description("Stale wiki, orphans, duplicates"))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runGarden(resolveOpts(cmd));
      process.exitCode = code;
    });

  addGlobalOptions(program.command("map").description("Generate architecture markdown and fingerprints"))
    .option("--refresh", "recompute fingerprints; update generated region")
    .option("--lsp", "require a language server on PATH")
    .option("--no-lsp", "force the fallback parser")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { refresh?: boolean };
      const code = await runMap(resolveOpts(cmd), flags, process.argv);
      process.exitCode = code;
    });

  const skills = addGlobalOptions(program.command("skills").description("Pinned skill overlays"));
  skills
    .allowExcessArguments(false)
    .action(requireSub("skills", "list, install, or show", "legion-cli skills list"));
  addGlobalOptions(skills.command("list").description("List packaged and overlay skills"))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runSkillsList(resolveOpts(cmd));
      process.exitCode = code;
    });
  addGlobalOptions(skills.command("show").description("Show one packaged or overlay skill"))
    .argument("<id>", "skill id")
    .allowExcessArguments(false)
    .action(async (id: string, _opts, cmd: Command) => {
      const code = await runSkillsShow(resolveOpts(cmd), id);
      process.exitCode = code;
    });
  addGlobalOptions(skills.command("install").description("Install a pinned skill overlay"))
    .argument("<source>", "local directory or github:owner/repo@tag")
    .option("--unsigned", "allow a local overlay with no minisign signature (TTY warn)")
    .option("--skill <id>", "skill id when the bundle contains more than one")
    .option("--integrity <sha256>", "sha256:<hex> expected tree digest")
    .allowExcessArguments(false)
    .action(async (source: string, opts, cmd: Command) => {
      const flags = opts as { unsigned?: boolean; skill?: string; integrity?: string };
      const code = await runSkillsInstall(resolveOpts(cmd), source, {
        unsigned: Boolean(flags.unsigned),
        skill: flags.skill,
        integrity: flags.integrity,
      });
      process.exitCode = code;
    });

  const context = addGlobalOptions(program.command("context").description("Session context"));
  context.allowExcessArguments(false).action(requireSub("context", "compact", "legion-cli context compact"));
  addGlobalOptions(context.command("compact").description("Compact done tasks"))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runContextCompact(resolveOpts(cmd));
      process.exitCode = code;
    });

  program.addHelpCommand(false);
  program
    .command("help")
    .description("Commands")
    .argument("[command]", "command to show help for")
    .option("--all", "show the full command surface")
    .action((command: string | undefined, opts: { all?: boolean }) => {
      if (opts.all) {
        printHelpAll();
        return;
      }
      if (command) {
        const sub = program.commands.find((entry) => entry.name() === command);
        if (!sub) {
          printUnknownCommand(command);
          process.exitCode = 1;
          return;
        }
        sub.outputHelp();
        return;
      }
      printHelpLayer1();
    });

  return program;
}

export async function runCli(argv: string[]): Promise<number> {
  process.exitCode = 0;
  const program = createProgram();
  const json = argv.includes("--json");
  try {
    await program.parseAsync(argv);
    return process.exitCode ?? 0;
  } catch (err) {
    if (err instanceof EngineLockedError) {
      printRefuse({ message: err.message, nextHint: HINT.status }, json);
      return 1;
    }
    if (err instanceof LegionRefuseError || err instanceof DesignSystemError) {
      printRefuse(err, json);
      return 1;
    }
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    } else {
      writeErr(message);
    }
    return 1;
  }
}
