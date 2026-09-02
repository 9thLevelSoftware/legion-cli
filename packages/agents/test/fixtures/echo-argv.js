import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

writeFileSync(join(process.cwd(), "argv.json"), `${JSON.stringify(process.argv)}\n`, "utf8");

const pointer = process.argv.at(-1) ?? "";
const match = /runId=([^,\s)]+)/.exec(pointer);
if (match) {
  const summary = join(process.cwd(), ".legion-cli", "cache", "runs", match[1], "summary.md");
  mkdirSync(dirname(summary), { recursive: true });
  writeFileSync(summary, "generic echo done\n", "utf8");
}
