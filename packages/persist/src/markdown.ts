import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ZodType } from "zod";
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

export function parseMarkdownDocument(markdown: string): { frontmatter: unknown; body: string } {
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
  return parseYaml(text);
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

export async function writeTextFile(absPath: string, contents: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, contents, "utf8");
}

export async function readMarkdownFile<T>(
  absPath: string,
  storePath: string,
  schema: ZodType<T>,
): Promise<MarkdownDoc<T>> {
  const raw = await readTextFile(absPath);
  const { frontmatter, body } = parseMarkdownDocument(raw);
  return { data: parseWithSchema(storePath, schema, frontmatter), body };
}

export async function writeMarkdownFile(
  absPath: string,
  frontmatter: unknown,
  body: string,
): Promise<void> {
  await writeTextFile(absPath, formatMarkdownDocument(frontmatter, body));
}

export async function readYamlFile<T>(
  absPath: string,
  storePath: string,
  schema: ZodType<T>,
): Promise<T> {
  const raw = await readTextFile(absPath);
  return parseWithSchema(storePath, schema, parseYamlDocument(raw));
}

export async function writeYamlFile(absPath: string, data: unknown): Promise<void> {
  await writeTextFile(absPath, formatYamlDocument(data));
}
