import { resolve } from "node:path";
import type { Command } from "commander";
import type { LegionRefuseError } from "@9thlevelsoftware/legion-cli-core";

export type CliOpts = {
  project: string;
  json: boolean;
  yes: boolean;
  verbose: boolean;
  blockers: boolean;
  plain: boolean;
};

let activeProjectScope: string | undefined;

function quoteProjectForShell(project: string): string {
  // CLI hints are copy/paste commands. JSON string escaping is not shell escaping:
  // PowerShell uses doubled apostrophes, while POSIX joins single-quoted segments.
  if (process.platform === "win32") return `'${project.replaceAll("'", "''")}'`;
  return `'${project.replaceAll("'", "'\\''")}'`;
}

function isCliSuggestion(command: string): boolean {
  return /(?:^|\s)(?:pnpm\s+exec\s+)?legion-cli(?:\s|$)/.test(command);
}

function scopeSuggestedCommand(command: string): string {
  if (!activeProjectScope || !isCliSuggestion(command) || /(?:^|\s)--project(?:\s|=|$)/.test(command)) return command;
  return `${command} --project ${quoteProjectForShell(activeProjectScope)}`;
}

/** Keep every copy/paste lifecycle suggestion in the project selected for this invocation. */
function scopeSuggestedText(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      // Only command-bearing hint lines are rewritten. Diagnostics can name a
      // binary or include an executable path; those are evidence, not a
      // command the operator should paste back into a shell.
      if (!/^\s*(?:Next:|Run:|Viewer:|Hint:|Recover:|Supported command:|\(run\s+)/i.test(line)) return line;
      const match = /(?:pnpm\s+exec\s+)?legion-cli\b/.exec(line);
      if (!match || match.index === undefined) return line;
      const prefix = line.slice(0, match.index);
      let command = line.slice(match.index);
      // Hints such as `--adapter claude|…` are rendered as one suggestion. Do
      // not stop at `|`: doing so inserted --project into the middle of it.
      // The only punctuation we strip is a closing parenthesis that belongs to
      // prose such as `(run legion-cli help --all)`.
      let suffix = "";
      if (command.endsWith(")") && prefix.includes("(")) {
        command = command.slice(0, -1);
        suffix = ")";
      }
      return `${prefix}${scopeSuggestedCommand(command)}${suffix}`;
    })
    .join("\n");
}

function scopeJsonSuggestions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scopeJsonSuggestions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      (key === "next" || key === "nextHint" || key === "run") && typeof child === "string" && isCliSuggestion(child)
        ? scopeSuggestedCommand(child)
        : scopeJsonSuggestions(child),
    ]),
  );
}

export function resolveOpts(cmd: Command): CliOpts {
  const o = cmd.optsWithGlobals() as Record<string, unknown>;
  const project = typeof o.project === "string" && o.project.length > 0 ? o.project : process.cwd();
  const resolved = {
    project: resolve(project),
    json: Boolean(o.json),
    yes: Boolean(o.yes),
    verbose: Boolean(o.verbose),
    blockers: Boolean(o.blockers),
    plain: Boolean(o.plain),
  };
  activeProjectScope = resolved.project;
  return resolved;
}

export function writeOut(text: string): void {
  const scoped = scopeSuggestedText(text);
  process.stdout.write(scoped.endsWith("\n") ? scoped : `${scoped}\n`);
}

export function writeErr(text: string): void {
  const scoped = scopeSuggestedText(text);
  process.stderr.write(scoped.endsWith("\n") ? scoped : `${scoped}\n`);
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(scopeJsonSuggestions(value), null, 2)}\n`);
}

/** One compact JSON object per physical line for streaming interactive output. */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(scopeJsonSuggestions(value))}\n`;
}

export function writeJsonLine(value: unknown): void {
  process.stdout.write(serializeJsonLine(value));
}

export function printRefuse(err: Pick<LegionRefuseError, "message" | "nextHint">, json: boolean): void {
  if (json) {
    writeJson({ error: err.message, next: scopeSuggestedCommand(err.nextHint) });
    return;
  }
  writeErr(`${err.message}\nNext: ${err.nextHint}`);
}

/** One printed line per agent-filed ticket: what it will run, where the commands came from, what it may touch. */
export function ticketVerificationLine(filed: {
  id: string;
  verificationCommands: readonly string[];
  filesAllowed: readonly string[];
  verificationSource: string;
}): string {
  return `${filed.id} verification (from ${filed.verificationSource}): ${filed.verificationCommands.join(" ; ")} [filesAllowed: ${filed.filesAllowed.join(", ")}]`;
}
