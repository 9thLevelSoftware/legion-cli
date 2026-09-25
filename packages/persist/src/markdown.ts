import { readFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ZodType } from "zod";
import { atomicWriteFile, isWin32BusyError } from "./atomic-write.js";
import { PersistValidationError } from "./errors.js";
import { journaledWriteFile } from "./pre-image.js";

export type MarkdownDoc<T> = {
  data: T;
  body: string;
};

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested !== undefined) out[key] = stripUndefined(nested);
    }
    return out;
  }
  return value;
}

export function parseMarkdownDocument(input: string): { frontmatter: unknown; body: string } {
  // Windows PowerShell 5.1 `Set-Content -Encoding UTF8` and Notepad prepend a UTF-8 BOM.
  const markdown = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/.exec(markdown);
  if (!match) {
    throw new PersistValidationError("<markdown>", new Error("expected YAML frontmatter"));
  }
  const frontmatter = parseYaml(match[1]);
  const body = markdown.slice(match[0].length).replace(/^\r?\n/, "");
  return { frontmatter, body };
}

export function formatMarkdownDocument(frontmatter: unknown, body: string): string {
  const yaml = stringifyYaml(stripUndefined(frontmatter), { lineWidth: 0 }).trimEnd();
  const normalized = body.replaceAll("\r\n", "\n");
  if (normalized.length === 0) {
    return `---\n${yaml}\n---\n`;
  }
  const withNl = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  return `---\n${yaml}\n---\n\n${withNl}`;
}

export function formatYamlDocument(data: unknown): string {
  const yaml = stringifyYaml(stripUndefined(data), { lineWidth: 0 });
  return yaml.endsWith("\n") ? yaml : `${yaml}\n`;
}

export function parseYamlDocument(text: string): unknown {
  return parseYaml(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export function parseWithSchema<T>(
  path: string,
  schema: ZodType<T>,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PersistValidationError(path, result.error);
  }
  return result.data;
}

/** Deterministic work counters (KD-3). Never a timer. */
export const persistWork = {
  parseAttempts: 0,
  taskFileReads: 0,
  auditBytesRead: 0,
};

export function resetPersistWork(): void {
  persistWork.parseAttempts = 0;
  persistWork.taskFileReads = 0;
  persistWork.auditBytesRead = 0;
}

const TASK_MARKDOWN_RE = /(?:^|[\\/])\.legion-cli[\\/]tasks[\\/][^\\/]+\.md$/i;

export function isTaskMarkdownPath(absPath: string): boolean {
  return TASK_MARKDOWN_RE.test(absPath);
}

export async function readTextFile(absPath: string): Promise<string> {
  if (isTaskMarkdownPath(absPath)) persistWork.taskFileReads += 1;
  return readFile(absPath, "utf8");
}

export type WriteTextOpts = {
  /**
   * Project root (required): every directory between it and the target is checked for links,
   * so no caller can silently get the weaker target-and-parent check (KD-8).
   */
  root: string;
  /** Restore applies bytes through this funnel without re-attributing them as engine writes. */
  skipJournal?: boolean;
  commandId?: string | null;
};

/** Atomic (temp + fsync + rename) and link-refusing; journaled for engine-SoT paths. */
export async function writeTextFile(
  absPath: string,
  contents: string | Buffer,
  opts: WriteTextOpts,
): Promise<void> {
  if (opts.skipJournal) {
    await atomicWriteFile(absPath, contents, { root: opts.root });
  } else {
    await journaledWriteFile(opts.root, absPath, contents, { commandId: opts.commandId });
  }
  if (isTaskMarkdownPath(absPath)) {
    try {
      const { rememberTaskWrite } = await import("./tasks-list.js");
      await rememberTaskWrite(opts.root, absPath, contents);
    } catch {
      // derived cache
    }
  }
}

export const SOT_READ_ATTEMPTS = 5;
export const SOT_READ_RETRY_MS = 20;

/**
 * Read a source-of-truth file. Retry only win32 I/O races (ENOENT / sharing during rename).
 * Parse/validation errors are deterministic: one attempt (F-025). POSIX rename is atomic.
 */
async function readParsed<T>(absPath: string, parse: (raw: string) => T): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < SOT_READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, SOT_READ_RETRY_MS));
    let raw: string;
    try {
      raw = await readTextFile(absPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "ENOENT" || isWin32BusyError(err))) {
        lastErr = err;
        continue;
      }
      throw err;
    }
    persistWork.parseAttempts += 1;
    return parse(raw);
  }
  throw lastErr;
}

export async function readMarkdownFile<T>(
  absPath: string,
  storePath: string,
  schema: ZodType<T>,
): Promise<MarkdownDoc<T>> {
  return readParsed(absPath, (raw) => {
    const { frontmatter, body } = parseMarkdownDocument(raw);
    return { data: parseWithSchema(storePath, schema, frontmatter), body };
  });
}

export async function writeMarkdownFile(
  absPath: string,
  frontmatter: unknown,
  body: string,
  opts: WriteTextOpts,
): Promise<void> {
  await writeTextFile(absPath, formatMarkdownDocument(frontmatter, body), opts);
}

export async function readYamlFile<T>(
  absPath: string,
  storePath: string,
  schema: ZodType<T>,
): Promise<T> {
  return readParsed(absPath, (raw) => parseWithSchema(storePath, schema, parseYamlDocument(raw)));
}

export async function writeYamlFile(absPath: string, data: unknown, opts: WriteTextOpts): Promise<void> {
  await writeTextFile(absPath, formatYamlDocument(data), opts);
}
