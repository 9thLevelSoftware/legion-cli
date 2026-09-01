import { createLegionEngine, HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import { AdapterIdSchema, type AdapterId } from "@9thlevelsoftware/legion-cli-schema";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { promptIfTty } from "./prompt.js";

export type InitFlags = {
  name?: string;
  adapter?: string;
  mode?: string;
  genericBinary?: string;
  genericArgs?: string[];
};

async function requireValue(
  flag: string | undefined,
  prompt: string,
  message: string,
  nextHint: string,
): Promise<string> {
  const fromFlag = flag?.trim();
  if (fromFlag) return fromFlag;
  const typed = await promptIfTty(prompt);
  if (typed) return typed;
  refuse(message, nextHint);
}

export async function runInit(opts: CliOpts, flags: InitFlags): Promise<number> {
  const mode = (flags.mode ?? "greenfield").trim();
  if (mode === "brownfield") {
    refuse("legion-cli init --mode brownfield is v1", HINT.greenfield);
  }
  if (mode !== "greenfield") {
    refuse("legion-cli init is greenfield only in v0", HINT.greenfield);
  }

  const name = await requireValue(
    flags.name,
    "Product name: ",
    "init requires a product name",
    "legion-cli init --name <product>",
  );

  const adapterRaw = await requireValue(
    flags.adapter,
    "Adapter (claude|generic|fake): ",
    "adapter.default is required",
    "legion-cli init --adapter claude|generic|fake",
  );
  const adapterParsed = AdapterIdSchema.safeParse(adapterRaw);
  if (!adapterParsed.success) {
    refuse("adapter.default must be claude, generic, or fake", "legion-cli init --adapter claude|generic|fake");
  }
  const adapter: AdapterId = adapterParsed.data;

  let generic: { binary: string; args: string[] } | undefined;
  if (adapter === "generic") {
    const binary = await requireValue(
      flags.genericBinary,
      "Generic adapter binary: ",
      "adapter.generic is required when adapter.default is generic",
      "legion-cli init --adapter generic --generic-binary <bin>",
    );
    generic = { binary, args: flags.genericArgs ?? [] };
  }

  const engine = createLegionEngine(opts.project);
  await engine.init({ name, adapter, generic, mode: "greenfield" });

  if (opts.json) {
    writeJson({
      ok: true,
      name,
      mode: "greenfield",
      adapter,
      next: "legion-cli intent",
    });
    return 0;
  }

  writeOut(
    [
      "Legion CLI created a project in this folder.",
      "mode: greenfield",
      `adapter.default: ${adapter}`,
      "Supported command: pnpm exec legion-cli",
      "Next: legion-cli intent",
    ].join("\n"),
  );
  return 0;
}
