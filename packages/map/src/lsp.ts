import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSource } from "./parse.js";
import type { WalkedFile } from "./walk.js";

export const MAX_LSP_FILES = 500;
export const LSP_BUDGET_MS = 60_000;

export type LspSpawnFn = (command: string, args: readonly string[], cwd: string) => ChildProcess;

export type ResolveBinaryFn = (name: string) => string | null;

export type DetectedLsp = {
  binary: string;
  command: string;
  args: string[];
  languages: ReadonlySet<string>;
};

const EXPORT_SYMBOL_KINDS = new Set([
  2, // Module
  3, // Namespace
  5, // Class
  6, // Method
  9, // Constructor
  10, // Variable
  11, // Constant
  12, // Function
  13, // Interface
  14, // Enum
]);

type LspServerSpec = {
  binary: string;
  args: string[];
  markers: readonly string[];
  languages: readonly string[];
};

const SERVERS: readonly LspServerSpec[] = [
  {
    binary: "typescript-language-server",
    args: ["--stdio"],
    markers: ["tsconfig.json", "jsconfig.json"],
    languages: ["ts", "js"],
  },
  {
    binary: "gopls",
    args: [],
    markers: ["go.mod"],
    languages: ["go"],
  },
  {
    binary: "rust-analyzer",
    args: [],
    markers: ["Cargo.toml"],
    languages: ["rs"],
  },
  {
    binary: "pylsp",
    args: [],
    markers: ["pyproject.toml", "setup.cfg"],
    languages: ["py"],
  },
];

const LANGUAGE_IDS: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
};

function languageIdFor(posixPath: string, language: string): string {
  const ext = extname(posixPath).toLowerCase();
  if (ext === ".tsx") return "typescriptreact";
  if (ext === ".jsx") return "javascriptreact";
  return LANGUAGE_IDS[language] ?? "plaintext";
}

const LSP_ENV_ALLOWLIST = new Set(
  [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "TMPDIR",
    "ComSpec",
    "TERM",
    "LANG",
    "LC_ALL",
    "GOPATH",
    "GOROOT",
    "GO111MODULE",
    "GOPROXY",
    "GOMODCACHE",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "PYTHONPATH",
    "VIRTUAL_ENV",
    "NODE_PATH",
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "PATHEXT",
  ].map((key) => key.toUpperCase()),
);

type JsonRpc = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

function uniqueDirs(projectRoot: string, roots: readonly string[] | null): string[] {
  const dirs = [projectRoot];
  if (roots) {
    for (const root of roots) dirs.push(join(projectRoot, ...root.split("/")));
  }
  return dirs;
}

function markerPresent(dirs: readonly string[], markers: readonly string[]): boolean {
  return dirs.some((dir) => markers.some((marker) => existsSync(join(dir, marker))));
}

export function resolveOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!name) return null;
  if (name.includes("/") || name.includes("\\") || /^[A-Za-z]:/.test(name)) {
    return existsSync(name) ? name : null;
  }
  const pathKey =
    process.platform === "win32" ? Object.keys(env).find((key) => key.toLowerCase() === "path") : "PATH";
  const pathVal = (pathKey && env[pathKey]) || "";
  const delim = process.platform === "win32" ? ";" : ":";
  const extSource = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM") : "";
  const exts = process.platform === "win32" ? extSource.split(";").filter(Boolean) : [""];
  const hasExt =
    process.platform === "win32" && exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  const names = process.platform === "win32" && !hasExt ? [name, ...exts.map((ext) => `${name}${ext}`)] : [name];
  for (const dir of pathVal.split(delim).filter(Boolean)) {
    for (const candidate of names) {
      const abs = join(dir, candidate);
      if (existsSync(abs)) return abs;
    }
  }
  return null;
}

export function detectLspServer(
  projectRoot: string,
  roots: readonly string[] | null,
  resolveBinary: ResolveBinaryFn = resolveOnPath,
): DetectedLsp | null {
  const dirs = uniqueDirs(projectRoot, roots);
  for (const spec of SERVERS) {
    if (!markerPresent(dirs, spec.markers)) continue;
    const command = resolveBinary(spec.binary);
    if (!command) continue;
    return {
      binary: spec.binary,
      command,
      args: [...spec.args],
      languages: new Set(spec.languages),
    };
  }
  return null;
}

/** PATH/TERM plus language homes. Never SSH_AUTH_SOCK or API keys. */
export function lspSpawnEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper === "SSH_AUTH_SOCK" || upper === "NODE_TEST_CONTEXT") continue;
    if (!LSP_ENV_ALLOWLIST.has(upper)) continue;
    out[key] = value;
  }
  return out;
}

function quoteCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\t\r\n "]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}

function defaultSpawn(command: string, args: readonly string[], cwd: string): ChildProcess {
  const env = lspSpawnEnv();
  const common = {
    cwd,
    env,
    // ignore stderr so a chatty server cannot fill the pipe and deadlock
    stdio: ["pipe", "pipe", "ignore"] as ["pipe", "pipe", "ignore"],
    windowsHide: true,
    shell: false,
  };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const line = [command, ...args].map(quoteCmdArg).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], {
      ...common,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(command, [...args], common);
}

class LspFramer {
  #buf = Buffer.alloc(0);

  push(chunk: Buffer): JsonRpc[] {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    const messages: JsonRpc[] = [];
    while (true) {
      const headerEnd = this.#buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.#buf.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match?.[1]) {
        this.#buf = this.#buf.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.#buf.length < bodyStart + length) break;
      const body = this.#buf.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.#buf = this.#buf.subarray(bodyStart + length);
      try {
        messages.push(JSON.parse(body) as JsonRpc);
      } catch {
        // skip malformed frames
      }
    }
    return messages;
  }
}

function encodeFrame(msg: object): Buffer {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, json]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function symbolName(value: unknown): string | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) return null;
  if (typeof value.kind !== "number" || !EXPORT_SYMBOL_KINDS.has(value.kind)) return null;
  return value.name;
}

export function exportsFromDocumentSymbols(result: unknown, source?: string, posixPath?: string): string[] {
  if (!Array.isArray(result)) return [];
  const names: string[] = [];
  for (const item of result) {
    if (!isRecord(item)) continue;
    if ("selectionRange" in item || "children" in item) {
      const name = symbolName(item);
      if (name) names.push(name);
      continue;
    }
    if ("location" in item) {
      const container = item.containerName;
      if (typeof container === "string" && container.length > 0) continue;
      const name = symbolName(item);
      if (name) names.push(name);
    }
  }
  if (!source || !posixPath) return names;
  const declared = new Set(parseSource(posixPath, source).exports);
  if (declared.size === 0) return names;
  const exported = names.filter((name) => declared.has(name));
  return exported.length > 0 ? exported : names;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

class LspClient {
  #child: ChildProcess;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #dead = false;
  #exitError: Error | null = null;

  constructor(child: ChildProcess) {
    this.#child = child;
    const framer = new LspFramer();
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const msg of framer.push(chunk)) this.#onMessage(msg);
    });
    child.stderr?.on("data", () => {
      // drain so a piped chatty server cannot deadlock
    });
    child.stderr?.resume?.();
    const fail = (err: Error) => {
      this.#dead = true;
      this.#exitError = err;
      for (const pending of this.#pending.values()) pending.reject(err);
      this.#pending.clear();
    };
    child.once("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    child.once("exit", (code) => {
      if (this.#pending.size > 0) fail(new Error(`LSP server exited (${code ?? "null"})`));
      this.#dead = true;
    });
  }

  get dead(): boolean {
    return this.#dead;
  }

  get exitError(): Error | null {
    return this.#exitError;
  }

  #onMessage(msg: JsonRpc): void {
    if (msg.id !== undefined && msg.method) {
      this.send({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }
    if (msg.id === undefined) return;
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (msg.error) pending.reject(new Error(`LSP error: ${JSON.stringify(msg.error)}`));
    else pending.resolve(msg.result);
  }

  send(msg: object): void {
    if (!this.#child.stdin || this.#child.stdin.destroyed) {
      throw new Error("LSP stdin closed");
    }
    this.#child.stdin.write(encodeFrame(msg));
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.#dead) return Promise.reject(this.#exitError ?? new Error("LSP server exited"));
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`LSP ${method} timed out`));
      }, Math.max(1, timeoutMs));
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  kill(): void {
    this.#dead = true;
    for (const pending of this.#pending.values()) pending.reject(new Error("LSP client closed"));
    this.#pending.clear();
    try {
      this.#child.stdin?.end();
    } catch {
      // ignore
    }
    try {
      this.#child.kill();
    } catch {
      // ignore
    }
  }

  waitExit(ms: number): Promise<void> {
    const child = this.#child;
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function remaining(deadline: number): number {
  return deadline - Date.now();
}

export async function collectLspExports(opts: {
  projectRoot: string;
  files: readonly WalkedFile[];
  command: string;
  args: readonly string[];
  deadlineMs?: number;
  spawnLsp?: LspSpawnFn;
}): Promise<Map<string, string[]> | null> {
  const deadline = Date.now() + (opts.deadlineMs ?? LSP_BUDGET_MS);
  const files = opts.files.slice(0, MAX_LSP_FILES);
  let child: ChildProcess;
  try {
    const spawnFn = opts.spawnLsp ?? defaultSpawn;
    child = spawnFn(opts.command, opts.args, opts.projectRoot);
  } catch {
    return null;
  }
  if (!child.stdin || !child.stdout) {
    try {
      child.kill();
    } catch {
      // ignore
    }
    return null;
  }

  const client = new LspClient(child);
  const exportsByPath = new Map<string, string[]>();
  try {
    if (remaining(deadline) <= 0) return null;
    await client.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileURL(opts.projectRoot).href,
        capabilities: {
          workspace: { workspaceFolders: false },
          textDocument: {
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true,
            },
          },
        },
      },
      remaining(deadline),
    );
    client.notify("initialized", {});

    for (const file of files) {
      if (remaining(deadline) <= 0) return null;
      if (client.dead) return null;
      const uri = pathToFileURL(file.absPath).href;
      client.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: languageIdFor(file.path, file.language),
          version: 1,
          text: file.text,
        },
      });
      try {
        const result = await client.request(
          "textDocument/documentSymbol",
          { textDocument: { uri } },
          remaining(deadline),
        );
        exportsByPath.set(file.path, exportsFromDocumentSymbols(result, file.text, file.path));
      } catch {
        return null;
      }
    }

    if (remaining(deadline) > 0 && !client.dead) {
      try {
        await client.request("shutdown", null, Math.min(2000, remaining(deadline)));
        client.notify("exit", null);
      } catch {
        // shutdown is best-effort once symbols are in
      }
    }
    return exportsByPath;
  } catch {
    return null;
  } finally {
    client.kill();
    await client.waitExit(1000);
  }
}
