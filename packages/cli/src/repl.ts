import { spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import * as readline from "node:readline/promises";
import { format, inspect } from "node:util";
import vm from "node:vm";
import { scrubSecretsEnv } from "@9thlevelsoftware/legion-cli-agents";
import { HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeErr, writeOut } from "./io.js";

export type ReplOpts = CliOpts & {
  lang?: string;
};

const REPL_LANGS = new Set(["node", "js", "ts", "python", "py"]);

export const REPL_BANNER = "Legion REPL (host mode, NO SANDBOX; secrets visible to typed code)";

function createReplVmContext(root: string, env: Record<string, string | undefined>): vm.Context {
  const replConsole = {
    log: (...args: unknown[]) => writeOut(format(...args)),
    info: (...args: unknown[]) => writeOut(format(...args)),
    debug: (...args: unknown[]) => writeOut(format(...args)),
    warn: (...args: unknown[]) => writeErr(format(...args)),
    error: (...args: unknown[]) => writeErr(format(...args)),
    dir: (value: unknown) => writeOut(inspect(value)),
  };
  const replProcess = {
    env: { ...env },
    cwd: () => root,
    platform: process.platform,
    arch: process.arch,
    version: process.version,
    versions: process.versions,
    pid: process.pid,
    hrtime: process.hrtime,
    nextTick: process.nextTick,
  };
  return vm.createContext({
    console: replConsole,
    process: replProcess,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    crypto: globalThis.crypto,
    fetch: globalThis.fetch,
  });
}

function evaluateJsOrTsLine(line: string, lang: string, context: vm.Context): void {
  try {
    const stripped = lang === "ts" ? stripTypeScriptTypes(line) : line;
    if (!stripped.trim()) return;
    let code = stripped;
    if (/^\s*\{/.test(code) && !/;\s*$/.test(code)) {
      try {
        new vm.Script(`(${code})`);
        code = `(${code})`;
      } catch {
        // Not a standalone object literal expression; execute as written.
      }
    }
    const result = vm.runInContext(code, context);
    if (result !== undefined) {
      writeOut(inspect(result));
    }
  } catch (err) {
    writeErr(err instanceof Error ? inspect(err) : String(err));
  }
}

export async function runRepl(opts: ReplOpts): Promise<number> {
  const root = resolve(opts.project);
  const lang = (opts.lang ?? "node").trim().toLowerCase();
  if (!REPL_LANGS.has(lang)) {
    refuse(`repl --lang ${lang} is not allowed (node | python)`, HINT.status);
  }

  writeOut(`${REPL_BANNER} [${lang}]`);
  writeOut("Type code to execute, or '.exit' to quit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const env = scrubSecretsEnv(process.env);
  const isJsTs = lang === "node" || lang === "js" || lang === "ts";
  const vmContext = isJsTs ? createReplVmContext(root, env) : null;

  try {
    const promptText = `${lang}> `;
    if (process.stdin.isTTY) {
      rl.setPrompt(promptText);
      rl.prompt();
    }
    for await (const line of rl) {
      if (line.trim() === ".exit") break;
      if (line.trim() !== "") {
        if (vmContext) {
          evaluateJsOrTsLine(line, lang, vmContext);
        } else {
          const res = spawnSync("python", ["-c", line], {
            cwd: root,
            encoding: "utf8",
            windowsHide: true,
            env,
          });
          if (res.stdout) writeOut(res.stdout.trimEnd());
          if (res.stderr) writeErr(res.stderr.trimEnd());
        }
      }
      if (process.stdin.isTTY) {
        rl.prompt();
      }
    }
  } finally {
    rl.close();
  }

  writeOut("REPL session ended.");
  return 0;
}
