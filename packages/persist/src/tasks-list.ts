import { basename, join } from "node:path";
import { readdir } from "node:fs/promises";
import { TaskSchema, type Task } from "@9thlevelsoftware/legion-cli-schema";
import { ZodError } from "zod";
import { atomicWriteFile, retryFsOp } from "./atomic-write.js";
import { PersistValidationError } from "./errors.js";
import { legionPaths, taskPath } from "./layout.js";
import {
  parseMarkdownDocument,
  parseWithSchema,
  persistWork,
  readTextFile,
} from "./markdown.js";

export type TaskFileErrorKind = "validation" | "parse" | "transient";

export type TaskFileEntry =
  | { ok: true; file: string; id: string; task: Task }
  | {
      ok: false;
      file: string;
      id: string;
      /** First validation issue, e.g. `status: Invalid enum value …`. */
      error: string;
      /** validation = schema; parse = YAML/JSON; transient = retryable I/O (EBUSY). */
      kind?: TaskFileErrorKind;
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
  const code = (err as NodeJS.ErrnoException)?.code;
  if (typeof code === "string" && code && cause instanceof Error) return `${code}: ${cause.message}`;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

export function classifyTaskFileError(err: unknown): { error: string; kind: TaskFileErrorKind } {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
    return { error: describeError(err), kind: "transient" };
  }
  if (err instanceof PersistValidationError) {
    return { error: describeError(err), kind: "validation" };
  }
  return { error: describeError(err), kind: "parse" };
}

export type TaskSummary = {
  id: string;
  file: string;
  status: string;
  title: string;
  specId: string;
  adapter?: string | null;
  /** False when frontmatter fails TaskSchema (engine `#listTasks` drops these). */
  ok: boolean;
};

type TaskSummaryIndex = {
  version: 1;
  files: Record<string, TaskSummary>;
};

export const TASK_SUMMARIES_STORE = ".legion-cli/index/task-summaries.json";

function summariesAbs(projectRoot: string): string {
  return join(legionPaths(projectRoot).indexDir, "task-summaries.json");
}

function summaryFromFrontmatter(file: string, frontmatter: unknown): TaskSummary {
  const parsed = TaskSchema.safeParse(frontmatter);
  if (parsed.success) {
    return {
      id: parsed.data.id,
      file,
      status: parsed.data.status,
      title: parsed.data.title,
      specId: parsed.data.specId,
      adapter: parsed.data.adapter ?? null,
      ok: true,
    };
  }
  const rec = frontmatter && typeof frontmatter === "object" ? (frontmatter as Record<string, unknown>) : {};
  const id = typeof rec.id === "string" && rec.id ? rec.id : file.replace(/\.md$/i, "");
  return {
    id,
    file,
    status: typeof rec.status === "string" ? rec.status : "",
    title: typeof rec.title === "string" ? rec.title : "",
    specId: typeof rec.specId === "string" ? rec.specId : "",
    adapter: typeof rec.adapter === "string" ? rec.adapter : null,
    ok: false,
  };
}

function summaryFromContents(file: string, contents: string | Buffer): TaskSummary {
  const raw = Buffer.isBuffer(contents) ? contents.toString("utf8") : contents;
  try {
    return summaryFromFrontmatter(file, parseMarkdownDocument(raw).frontmatter);
  } catch {
    return {
      id: file.replace(/\.md$/i, ""),
      file,
      status: "",
      title: "",
      specId: "",
      ok: false,
    };
  }
}

async function readSummaryIndex(projectRoot: string): Promise<TaskSummaryIndex> {
  try {
    const parsed = JSON.parse(await readTextFile(summariesAbs(projectRoot))) as TaskSummaryIndex;
    if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === "object") return parsed;
  } catch {
    // missing or unreadable cache is rebuilt from names that are not yet indexed
  }
  return { version: 1, files: {} };
}

async function writeSummaryIndex(projectRoot: string, index: TaskSummaryIndex): Promise<void> {
  await atomicWriteFile(summariesAbs(projectRoot), `${JSON.stringify(index)}\n`, { root: projectRoot });
}

/** Derived cache: a miss is an extra read, never a refused write. */
export async function rememberTaskWrite(
  projectRoot: string,
  absPath: string,
  contents: string | Buffer,
): Promise<void> {
  const file = basename(absPath);
  if (!file.toLowerCase().endsWith(".md")) return;
  try {
    const index = await readSummaryIndex(projectRoot);
    index.files[file] = summaryFromContents(file, contents);
    await writeSummaryIndex(projectRoot, index);
  } catch {
    // ignore
  }
}

/**
 * Status-sized view of tasks/: readdir + the summary cache. Unindexed names are read once
 * and recorded. Bare status must not parse every task markdown file (F-048).
 */
export async function listTaskSummaries(projectRoot: string): Promise<TaskSummary[]> {
  const dir = legionPaths(projectRoot).tasksDir;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  names.sort((a, b) => a.localeCompare(b));
  const index = await readSummaryIndex(projectRoot);
  let dirty = false;
  const onDisk = new Set(names);
  for (const file of Object.keys(index.files)) {
    if (!onDisk.has(file)) {
      delete index.files[file];
      dirty = true;
    }
  }
  for (const file of names) {
    if (index.files[file] && typeof index.files[file].ok === "boolean") continue;
    const abs = join(dir, file);
    try {
      const raw = await retryFsOp(() => readTextFile(abs));
      persistWork.parseAttempts += 1;
      index.files[file] = summaryFromContents(file, raw);
    } catch {
      index.files[file] = {
        id: file.replace(/\.md$/i, ""),
        file,
        status: "",
        title: "",
        specId: "",
        ok: false,
      };
    }
    dirty = true;
  }
  if (dirty) {
    try {
      await writeSummaryIndex(projectRoot, index);
    } catch {
      // ignore
    }
  }
  return names.map((file) => index.files[file]).filter((row): row is TaskSummary => Boolean(row));
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
    let raw: string;
    try {
      raw = await retryFsOp(() => readTextFile(abs));
    } catch (err) {
      const classified = classifyTaskFileError(err);
      entries.push({ ok: false, file, id, error: classified.error, kind: classified.kind });
      continue;
    }
    try {
      persistWork.parseAttempts += 1;
      const { frontmatter } = parseMarkdownDocument(raw);
      try {
        const data = parseWithSchema(taskPath(id), TaskSchema, frontmatter);
        entries.push({ ok: true, file, id, task: data });
      } catch (err) {
        entries.push({
          ok: false,
          file,
          id,
          error:
            raw.length === 0
              ? "the file is empty (an interrupted write?); restore it from git or delete it"
              : describeError(err),
          kind: "validation",
          frontmatter,
        });
      }
    } catch (err) {
      entries.push({
        ok: false,
        file,
        id,
        error:
          raw.length === 0
            ? "the file is empty (an interrupted write?); restore it from git or delete it"
            : describeError(err),
        kind: "parse",
      });
    }
  }
  return entries;
}

/** The refusal text for an invalid task entry. */
export function invalidTaskMessage(entry: Extract<TaskFileEntry, { ok: false }>): string {
  return `${entry.file} is not a valid task: ${entry.error}. Fix the file, then re-run.`;
}
