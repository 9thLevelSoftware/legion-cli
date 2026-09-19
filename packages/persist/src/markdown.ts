import { readFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ZodType } from "zod";
import { atomicWriteFile, isWin32BusyError } from "./atomic-write.js";
import { PersistValidationError } from "./errors.js";

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

export async function readTextFile(absPath: string): Promise<string> {
  return readFile(absPath, "utf8");
}

export type WriteTextOpts = {
  /** Project root: every directory between it and the target is checked for links. */
  root?: string;
};

/** Atomic (temp + fsync + rename) and link-refusing; see {@link atomicWriteFile}. */
export async function writeTextFile(absPath: string, contents: string, opts?: WriteTextOpts): Promise<void> {
  await atomicWriteFile(absPath, contents, opts?.root ? { root: opts.root } : undefined);
}

export const SOT_READ_ATTEMPTS = 5;
export const SOT_READ_RETRY_MS = 20;

/**
 * Read and parse a source-of-truth file, retrying up to 5 x 20 ms when the parse fails (a
 * concurrent writer outside the lock, or a hand edit mid-save) and, on win32, when the read hits
 * ENOENT or a sharing violation during another process's rename. POSIX renames are atomic, so a
 * missing file there is final and is not retried.
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
    try {
      return parse(raw);
    } catch (err) {
      lastErr = err;
    }
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
  opts?: WriteTextOpts,
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

export async function writeYamlFile(absPath: string, data: unknown, opts?: WriteTextOpts): Promise<void> {
  await writeTextFile(absPath, formatYamlDocument(data), opts);
}
