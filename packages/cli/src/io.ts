import { resolve } from "node:path";
import type { Command } from "commander";
import { LegionRefuseError } from "@9thlevelsoftware/legion-cli-core";

export type CliOpts = {
  project: string;
  json: boolean;
  yes: boolean;
  verbose: boolean;
  blockers: boolean;
  plain: boolean;
};

export function resolveOpts(cmd: Command): CliOpts {
  const o = cmd.optsWithGlobals() as Record<string, unknown>;
  const project = typeof o.project === "string" && o.project.length > 0 ? o.project : process.cwd();
  return {
    project: resolve(project),
    json: Boolean(o.json),
    yes: Boolean(o.yes),
    verbose: Boolean(o.verbose),
    blockers: Boolean(o.blockers),
    plain: Boolean(o.plain),
  };
}

export function writeOut(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function writeErr(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printRefuse(err: LegionRefuseError, json: boolean): void {
  if (json) {
    writeJson({ error: err.message, next: err.nextHint });
    return;
  }
  writeErr(`${err.message}\nNext: ${err.nextHint}`);
}
