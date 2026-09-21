import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import * as readline from "node:readline/promises";
import type { CliOpts } from "./io.js";
import { writeErr, writeOut } from "./io.js";

export type ReplOpts = CliOpts & {
  lang?: string;
};

export async function runRepl(opts: ReplOpts): Promise<number> {
  const root = resolve(opts.project);
  const lang = opts.lang ?? "node";

  writeOut(`Legion REPL (${lang}) [host mode]`);
  writeOut("Type code to execute, or '.exit' to quit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const line = await rl.question(`${lang}> `);
      if (!line || line.trim() === ".exit") break;

      if (lang === "node" || lang === "js" || lang === "ts") {
        const res = spawnSync("node", ["-e", `try { console.log(${line}); } catch (e) { try { ${line}; } catch (err) { console.error(err); } }`], {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
        });
        if (res.stdout) writeOut(res.stdout.trimEnd());
        if (res.stderr) writeErr(res.stderr.trimEnd());
      } else if (lang === "python" || lang === "py") {
        const res = spawnSync("python", ["-c", line], {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
        });
        if (res.stdout) writeOut(res.stdout.trimEnd());
        if (res.stderr) writeErr(res.stderr.trimEnd());
      } else {
        const res = spawnSync(line, {
          cwd: root,
          shell: true,
          encoding: "utf8",
          windowsHide: true,
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
