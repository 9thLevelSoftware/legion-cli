import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskSchema, type Task } from "@9thlevelsoftware/legion-cli-schema";
import { ZodError } from "zod";
import { PersistValidationError } from "./errors.js";
import { legionPaths, taskPath } from "./layout.js";
import { parseMarkdownDocument, readMarkdownFile } from "./markdown.js";

export type TaskFileEntry =
  | { ok: true; file: string; id: string; task: Task }
  | {
      ok: false;
      file: string;
      id: string;
      /** First validation issue, e.g. `status: Invalid enum value …`. */
      error: string;
      /** Raw frontmatter when the YAML parsed, for callers that peek at specId/filesAllowed. */
      frontmatter?: unknown;
    };

function describeError(err: unknown): string {
  const cause = err instanceof PersistValidationError ? err.cause : err;
  // Duck-typed: the schema package may resolve its own zod copy.
  const issues = (cause as { issues?: unknown } | undefined)?.issues;
  if (cause instanceof ZodError || Array.isArray(issues)) {
    const issue = (issues as Array<{ path: PropertyKey[]; message: string }>)[0];
    if (issue) {
      const at = issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
      return `${at}${issue.message}`;
    }
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

async function peekFrontmatter(abs: string): Promise<unknown> {
  try {
    return parseMarkdownDocument(await readFile(abs, "utf8")).frontmatter;
  } catch {
    return undefined;
  }
}

/**
 * Every `*.md` under `.legion-cli/tasks/`, sorted by name. An unreadable or invalid file is an
 * `ok:false` entry, never dropped, so gates fail closed and viewers can show it.
 */
export async function listTaskFiles(projectRoot: string): Promise<TaskFileEntry[]> {
  const dir = legionPaths(projectRoot).tasksDir;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  names.sort((a, b) => a.localeCompare(b));
  const entries: TaskFileEntry[] = [];
  for (const file of names) {
    const id = file.replace(/\.md$/i, "");
    const abs = join(dir, file);
    try {
      const doc = await readMarkdownFile(abs, taskPath(id), TaskSchema);
      entries.push({ ok: true, file, id, task: doc.data });
    } catch (err) {
      const frontmatter = await peekFrontmatter(abs);
      entries.push({
        ok: false,
        file,
        id,
        error: describeError(err),
        ...(frontmatter !== undefined ? { frontmatter } : {}),
      });
    }
  }
  return entries;
}

/** The refusal text for an invalid task entry. */
export function invalidTaskMessage(entry: Extract<TaskFileEntry, { ok: false }>): string {
  return `${entry.file} is not a valid task: ${entry.error}. Fix the file, then re-run.`;
}
