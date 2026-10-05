import { LegionEngine } from "../../dist/index.js";

const POINTS = new Set(["after-begin-frame", "after-begin-head", "after-mutation", "after-end-frame", "after-end-head"]);
const dir = process.argv[2];
const point = process.argv[3];

if (!dir || !POINTS.has(point)) {
  process.stderr.write(`usage: governance-fault-child.mjs <projectRoot> <${[...POINTS].join("|")}>\n`);
  process.exit(2);
}

process.env.LEGION_CLI_ADAPTER = "fake";

const engine = new LegionEngine(dir, undefined, {
  fakeGovernanceFault: async (reached) => {
    if (reached !== point) return;
    process.kill(process.pid, "SIGKILL");
    // Self-termination can land after kill() returns (TerminateProcess is asynchronous on Windows):
    // block this thread so nothing past the fault point ever runs.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
});

const task = await engine.store.readTask("TSK-0001");
await engine.amendTask(task.data.id, task.data.contract);
process.stdout.write(`${JSON.stringify({ ok: true, survived: point })}\n`);
