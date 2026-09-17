import { LegionEngine } from "../../dist/index.js";

const dir = process.argv[2];
const skillsDir = process.argv[3];
const readyPath = process.argv[4];
const releasePath = process.argv[5];

if (!dir || !skillsDir || !readyPath || !releasePath) {
  process.stderr.write("usage: hold-execute.js <projectRoot> <skillsDir> <readyPath> <releasePath>\n");
  process.exit(2);
}

process.env.LEGION_CLI_ADAPTER = "fake";

const engine = new LegionEngine(dir, undefined, {
  skillsDir,
  fakeHoldWait: { readyPath, releasePath, timeoutMs: 30_000 },
});

const result = await engine.execute("auto");
process.stdout.write(`${JSON.stringify({ ok: true, status: result.status, taskId: result.taskId })}\n`);
