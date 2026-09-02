import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { LegionRefuseError } from "@9thlevelsoftware/legion-cli-core";
import { runBrief } from "./brief.js";
import { runDoctor } from "./doctor.js";
import { printHelpAll } from "./help-all.js";
import { runIngest } from "./ingest.js";
import { runInit } from "./init.js";
import { printRefuse, resolveOpts, writeErr } from "./io.js";
import { runSearch } from "./search.js";
import { runShow } from "./show.js";
import { runStatus } from "./status.js";
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
    .option("--adapter <id>", "claude | generic | fake (required)")
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

  addGlobalOptions(program.command("doctor").description("Is my laptop ready?")).action(
    async (_opts, cmd: Command) => {
      const code = await runDoctor(resolveOpts(cmd));
      process.exitCode = code;
    },
  );

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

  program.addHelpCommand(false);
  program
    .command("help")
    .description("Commands")
    .argument("[command]", "command to show help for")
    .option("--all", "show the full v0 command surface")
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
      program.outputHelp();
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
    if (err instanceof LegionRefuseError) {
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
