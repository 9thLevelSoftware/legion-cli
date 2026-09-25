import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import * as readline from "node:readline/promises";
import { scrubSecretsEnv } from "@9thlevelsoftware/legion-cli-agents";
import { HINT, refuse } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeErr, writeOut } from "./io.js";

export type ReplOpts = CliOpts & {
  lang?: string;
};

const REPL_LANGS = new Set(["node", "js", "ts", "python", "py"]);

export const REPL_BANNER = "Legion REPL (host mode, NO SANDBOX; secrets visible to typed code)";

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

  try {
    while (true) {
      const line = await rl.question(`${lang}> `);
      if (!line || line.trim() === ".exit") break;

      if (lang === "node" || lang === "js" || lang === "ts") {
        const res = spawnSync("node", ["-e", `try { console.log(${line}); } catch (e) { try { ${line}; } catch (err) { console.error(err); } }`], {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
          env,
        });
        if (res.stdout) writeOut(res.stdout.trimEnd());
        if (res.stderr) writeErr(res.stderr.trimEnd());
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
  } finally {
    rl.close();
  }

  writeOut("REPL session ended.");
  return 0;
}
