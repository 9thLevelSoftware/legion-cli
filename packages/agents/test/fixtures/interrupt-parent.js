// Spawns the sleep-tree agent through GenericAdapter, records pids, then either exits
// (mode "exit") or idles until signalled (mode "wait"). Used by interrupt.test.js.
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GenericAdapter } from "../../dist/index.js";
import { setupRun, fixturesDir } from "../helpers.js";

const [dir, mode] = process.argv.slice(2);
const { job } = await setupRun(dir, { timeoutMs: 120_000 });
const adapter = new GenericAdapter({ binary: process.execPath, args: [join(fixturesDir, "sleep-tree.js"), "{{pointer}}"] });
const handle = await adapter.spawn(job);
const childFile = join(dir, "child-pid.txt");
const started = Date.now();
while (!existsSync(childFile) && Date.now() - started < 20_000) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
await new Promise((resolve) => setTimeout(resolve, 200));
writeFileSync(join(dir, "agent-pid.txt"), `${handle.pid}\n`, "utf8");
if (mode === "exit") process.exit(0);
setInterval(() => {}, 1000);
