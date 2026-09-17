import { extname } from "node:path";
import type { ModuleFingerprint } from "@9thlevelsoftware/legion-cli-schema";

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_NAMES = 500;

export type SourceLanguage = ModuleFingerprint["language"];

export type ParseResult = {
  language: SourceLanguage;
  exports: string[];
  imports: string[];
};

const EXT_LANGUAGE: Record<string, Exclude<SourceLanguage, "other">> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "py",
  ".go": "go",
  ".rs": "rs",
};

export function languageFromPath(posixPath: string): SourceLanguage {
  return EXT_LANGUAGE[extname(posixPath).toLowerCase()] ?? "other";
}

function capture(source: string, re: RegExp, group = 1): string[] {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const copy = new RegExp(re.source, flags);
  const out: string[] = [];
  for (const match of source.matchAll(copy)) {
    const value = match[group];
    if (value) out.push(value);
  }
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].slice(0, MAX_NAMES);
}

function parseTsJs(source: string): { exports: string[]; imports: string[] } {
  const exports = [
    ...capture(source, /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g),
    ...capture(source, /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g),
    ...capture(source, /\bexport\s+(?:type|interface|const|enum)\s+([A-Za-z_$][\w$]*)/g),
    ...capture(source, /\bmodule\.exports\.([A-Za-z_$][\w$]*)/g),
    ...capture(source, /\bexports\.([A-Za-z_$][\w$]*)/g),
  ];
  if (/\bmodule\.exports\b/.test(source)) exports.push("module.exports");
  const imports = [
    ...capture(source, /\bfrom\s+['"]([^'"]+)['"]/g),
    ...capture(source, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
  ];
  return { exports: unique(exports), imports: unique(imports) };
}

function parsePython(source: string): { exports: string[]; imports: string[] } {
  return {
    exports: unique([
      ...capture(source, /^def\s+([A-Za-z_][\w]*)/gm),
      ...capture(source, /^class\s+([A-Za-z_][\w]*)/gm),
    ]),
    imports: unique([
      ...capture(source, /^from\s+(\S+)/gm),
      ...capture(source, /^import\s+(\S+)/gm),
    ]),
  };
}

function parseGo(source: string): { exports: string[]; imports: string[] } {
  const imports = [
    ...capture(source, /^import\s+"([^"]+)"/gm),
    ...capture(source, /^import\s+[A-Za-z_][\w.]*\s+"([^"]+)"/gm),
  ];
  for (const block of source.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) {
    imports.push(...capture(block[1] ?? "", /"([^"]+)"/g));
  }
  return {
    exports: unique([
      ...capture(source, /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/gm),
      ...capture(source, /^type\s+([A-Za-z_][\w]*)/gm),
    ]),
    imports: unique(imports),
  };
}

function parseRust(source: string): { exports: string[]; imports: string[] } {
  return {
    exports: unique(capture(source, /^pub\s+(?:fn|struct|enum|trait|mod)\s+([A-Za-z_][\w]*)/gm)),
    imports: [],
  };
}

export function parseSource(posixPath: string, source: string): ParseResult {
  const language = languageFromPath(posixPath);
  if (language === "other") return { language, exports: [], imports: [] };
  const parsed =
    language === "ts" || language === "js"
      ? parseTsJs(source)
      : language === "py"
        ? parsePython(source)
        : language === "go"
          ? parseGo(source)
          : parseRust(source);
  return { language, ...parsed };
}
