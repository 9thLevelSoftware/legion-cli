import { jsonDepthLimit } from "./canonical-json.js";

export interface StrictJsonOptions {
  maxBytes?: number;
  maxDepth?: number;
}

export const DEFAULT_STRICT_JSON_MAX_BYTES = 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function assertWellFormed(text: string): void {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new SyntaxError("JSON contains an unpaired Unicode surrogate");
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new SyntaxError("JSON contains an unpaired Unicode surrogate");
    }
  }
}

/** Preflight ambiguity and resource bounds before the document reaches JSON.parse or a schema. */
export function parseStrictJson(input: string | Uint8Array, options: StrictJsonOptions = {}): unknown {
  const maxBytes = options.maxBytes ?? DEFAULT_STRICT_JSON_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("JSON maxBytes must be a positive safe integer");
  }
  const maxDepth = jsonDepthLimit(options.maxDepth);
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (bytes > maxBytes) throw new RangeError("JSON exceeds maximum byte length");
  let text: string;
  if (typeof input === "string") {
    assertWellFormed(input);
    text = input;
  } else {
    try {
      text = utf8.decode(input);
    } catch (cause) {
      throw new SyntaxError("JSON input is not valid UTF-8", { cause });
    }
  }
  let cursor = 0;

  function invalid(): never {
    throw new SyntaxError(`Invalid JSON at character ${cursor}`);
  }

  function whitespace(): void {
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      cursor++;
    }
  }

  function string(): string {
    const start = cursor++;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor++);
      if (code === 0x22) {
        const decoded = JSON.parse(text.slice(start, cursor)) as string;
        assertWellFormed(decoded);
        return decoded;
      }
      if (code < 0x20) invalid();
      if (code === 0x5c) {
        const escape = text[cursor++];
        if (escape === "u") {
          for (let count = 0; count < 4; count++) {
            const hex = text.charCodeAt(cursor++);
            if (!((hex >= 0x30 && hex <= 0x39) || (hex >= 0x41 && hex <= 0x46) || (hex >= 0x61 && hex <= 0x66))) {
              invalid();
            }
          }
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          invalid();
        }
      }
    }
    return invalid();
  }

  function digit(): boolean {
    const code = text.charCodeAt(cursor);
    return code >= 0x30 && code <= 0x39;
  }

  function number(): void {
    const start = cursor;
    if (text[cursor] === "-") cursor++;
    if (!digit()) invalid();
    if (text[cursor] === "0") cursor++;
    else while (digit()) cursor++;
    if (text[cursor] === ".") {
      cursor++;
      if (!digit()) invalid();
      while (digit()) cursor++;
    }
    if (text[cursor] === "e" || text[cursor] === "E") {
      cursor++;
      if (text[cursor] === "+" || text[cursor] === "-") cursor++;
      if (!digit()) invalid();
      while (digit()) cursor++;
    }
    if (!Number.isFinite(Number(text.slice(start, cursor)))) {
      throw new SyntaxError("JSON requires finite numbers");
    }
  }

  function value(depth: number): void {
    whitespace();
    const token = text[cursor];
    if (token === "{") {
      if (depth >= maxDepth) throw new RangeError("JSON exceeds maximum depth");
      cursor++;
      whitespace();
      const keys = new Set<string>();
      if (text[cursor] !== "}") {
        while (true) {
          if (text[cursor] !== '"') invalid();
          const key = string();
          if (keys.has(key)) throw new SyntaxError("JSON contains a duplicate object key");
          keys.add(key);
          whitespace();
          if (text[cursor++] !== ":") invalid();
          value(depth + 1);
          whitespace();
          if (text[cursor] !== ",") break;
          cursor++;
          whitespace();
        }
      }
      if (text[cursor++] !== "}") invalid();
    } else if (token === "[") {
      if (depth >= maxDepth) throw new RangeError("JSON exceeds maximum depth");
      cursor++;
      whitespace();
      if (text[cursor] !== "]") {
        while (true) {
          value(depth + 1);
          whitespace();
          if (text[cursor] !== ",") break;
          cursor++;
        }
      }
      if (text[cursor++] !== "]") invalid();
    } else if (token === '"') {
      string();
    } else if (token === "-" || digit()) {
      number();
    } else {
      let literal: string;
      if (token === "t") literal = "true";
      else if (token === "f") literal = "false";
      else if (token === "n") literal = "null";
      else return invalid();
      if (!text.startsWith(literal, cursor)) invalid();
      cursor += literal.length;
    }
  }

  value(0);
  whitespace();
  if (cursor !== text.length) invalid();
  return JSON.parse(text) as unknown;
}
