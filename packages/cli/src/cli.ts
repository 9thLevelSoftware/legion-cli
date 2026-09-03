import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, Help } from "commander";
import { LegionRefuseError } from "@9thlevelsoftware/legion-cli-core";
import { DesignSystemError } from "@9thlevelsoftware/legion-cli-design-system";
import { ADAPTER_ID_HELP } from "@9thlevelsoftware/legion-cli-schema";
import { runAbandon } from "./abandon.js";
import { runBrief } from "./brief.js";
import { runBrownfield } from "./brownfield.js";
import { runDashboard } from "./dashboard.js";
import { runDiscuss } from "./discuss.js";
import { runDoctor } from "./doctor.js";
import { runExecute } from "./execute.js";
import { runFix } from "./fix.js";
import { formatHelpLayer1, printHelpAll, printHelpLayer1 } from "./help-all.js";
import { runIngest } from "./ingest.js";
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
import { runTaskAmend } from "./task.js";
import { runTicketCreate } from "./ticket.js";
import { runVerify } from "./verify.js";
import { runContextCompact } from "./context.js";
import { runGarden } from "./garden.js";
import { runWikiTrust } from "./wiki.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string };

function addGlobalOptions(cmd: Command): Command {
  return cmd
    .option("--project <dir>", "project directory")
    .option("--json", "machine-readable output")
    .option("--yes", "non-gate confirms only")
    .option("--verbose", "verbose logging");
}

function addStatusOptions(cmd: Command): Command {
  return cmd.option("--blockers", "list blocked work").option("--plain", "compact output");
}

function printUnknownCommand(name: string): void {
  writeErr(`unknown command '${name}'\n(run legion-cli help --all)`);
}

const builtinHelp = new Help();

export function createProgram(): Command {
  const program = new Command();
  addGlobalOptions(program);
  addStatusOptions(program);
  program
    .name("legion-cli")
    .description(
      "Product Engineering lifecycle engine.\nSupported invocation: pnpm exec legion-cli\nDoes not register bin legion.",
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
    .option("--mode <mode>", "greenfield (v0) or brownfield (v1)", "greenfield")
    .option("--generic-binary <bin>", "binary when --adapter generic")
    .option("--generic-args <args...>", "args when --adapter generic")
    .action(async (opts, cmd: Command) => {
      const flags = opts as {
        name?: string;
        adapter?: string;
        mode?: string;
        genericBinary?: string;
        genericArgs?: string[];
      };
      const code = await runInit(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  addGlobalOptions(program.command("doctor").description("Is my laptop ready?"))
    .option("--metrics", "local-only audit metrics (never phones home)")
    .action(async (opts, cmd: Command) => {
      const flags = opts as { metrics?: boolean };
      const code = await runDoctor(resolveOpts(cmd), { metrics: Boolean(flags.metrics) });
      process.exitCode = code;
    });

  addGlobalOptions(program.command("ingest").description("Teach Legion CLI from these files/links"))
    .argument("[sources...]", "files, directories, or https URLs")
    .option("--transcript <path>", "ingest an agent transcript")
    .option("--diff <range>", "ingest a git diff range")
    .option("--no-commit", "skip auto-commit of wiki pages")
    .action(async (sources: string[], opts, cmd: Command) => {
      const flags = opts as { transcript?: string; diff?: string; commit?: boolean };
      const code = await runIngest(resolveOpts(cmd), sources, flags);
      process.exitCode = code;
    });

  const wiki = addGlobalOptions(program.command("wiki").description("Wiki operations"));
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

  addGlobalOptions(program.command("show").description("Open one wiki/spec/task page"))
    .argument("<page>", "wiki page, spec, or task")
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
  addGlobalOptions(program.command("mcp").description("Read-only stdio MCP server"))
    .allowExcessArguments(false)
    .action(async (_opts, cmd: Command) => {
      const code = await runMcp(resolveOpts(cmd));
      process.exitCode = code;
    });

  addGlobalOptions(program.command("intent").description("Interview me about the product"))
    .option("--resume", "continue an in-progress interview")
    .option("--done", "finish after round 2 (still requires confirm)")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { resume?: boolean; done?: boolean };
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
    .option("--until-blocked", "loop until no ready task remains or one blocks")
    .option("--fix", "fix-run prompt (keep reproducing tests)")
    .option("--adapter <id>", ADAPTER_ID_HELP)
    .allowExcessArguments(false)
    .action(async (id: string | undefined, opts, cmd: Command) => {
      const flags = opts as { untilBlocked?: boolean; fix?: boolean; adapter?: string };
      const code = await runExecute(resolveOpts(cmd), {
        id,
        untilBlocked: Boolean(flags.untilBlocked),
        fix: Boolean(flags.fix),
        adapter: flags.adapter,
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

  addGlobalOptions(program.command("review").description("Spec-level review; fix tasks mean FAIL and re-review"))
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
    .allowExcessArguments(false)
    .action(async (bug: string[], opts, cmd: Command) => {
      const flags = opts as { adapter?: string };
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

  addGlobalOptions(program.command("dashboard").description("Open the visual board (viewer with optional writes; not the source of truth)"))
    .option("--no-open", "do not open a browser")
    .option("--port <port>", "port (default 7420)")
    .option("--expose", "bind 0.0.0.0 (warning)")
    .allowExcessArguments(false)
    .action(async (opts, cmd: Command) => {
      const flags = opts as { open?: boolean; port?: string; expose?: boolean };
      const code = await runDashboard(resolveOpts(cmd), flags);
      process.exitCode = code;
    });

  const packet = addGlobalOptions(program.command("packet").description("PM/designer request without the DAG"));
  packet.allowExcessArguments(false).action(() => {
    writeErr("packet requires new or respond\nNext: legion-cli packet new --title <title>");
    process.exitCode = 1;
  });
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

  addGlobalOptions(
    program.command("brownfield").description("Audit an existing app (effort 1: architecture + code)"),
  )
    .argument("[context...]", "scope notes")
    .option("--effort <n>", "analysis rigor 1–5 (effort 1 implemented)", "1")
    .option("--execute", "isolate product writes in a git worktree")
    .option("--resume <id>", "resume a brownfield run")
    .allowExcessArguments(false)
    .action(async (context: string[], opts, cmd: Command) => {
      const flags = opts as { effort?: string; execute?: boolean; resume?: string };
      const code = await runBrownfield(resolveOpts(cmd), {
        effort: flags.effort,
        execute: Boolean(flags.execute),
        resume: flags.resume,
        context,
      });
      process.exitCode = code;
    });

  const run = addGlobalOptions(program.command("run").description("Brownfield run artifacts"));
  addGlobalOptions(run.command("promote").description("Copy brownfield run pages into the wiki"))
    .argument("<id>", "brownfield run id")
    .allowExcessArguments(false)
    .action(async (id: string, _opts, cmd: Command) => {
      const code = await runPromote(resolveOpts(cmd), id);
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

  addGlobalOptions(designSystem.command("install").description("Copy a local design-system directory"))
    .argument("<dir>", "local directory (github: rejected)")
    .allowExcessArguments(false)
    .action(async (dir: string, _opts, cmd: Command) => {
      const code = await runDesignSystemInstall(resolveOpts(cmd), dir);
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

  const context = addGlobalOptions(program.command("context").description("Session context"));
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
