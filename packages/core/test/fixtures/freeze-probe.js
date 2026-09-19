// A second process that tries engine writes while another process's agent run is live (KD-2).
import { LegionEngine, LegionRefuseError } from "../../dist/index.js";

const dir = process.argv[2];
if (!dir) {
  process.stderr.write("usage: freeze-probe.js <projectRoot>\n");
  process.exit(2);
}

const engine = new LegionEngine(dir);
const attempts = {
  qaChecklist: () => engine.qaChecklist(["AC-1"]),
  ingest: () => engine.ingest(["notes.md"], { noCommit: true }),
  packetRespond: () => engine.respondPacket({ id: "PKT-0001", message: "ok" }),
  wikiTrust: () => engine.wikiTrust("product/intent"),
};

const out = {};
for (const [name, run] of Object.entries(attempts)) {
  try {
    await run();
    out[name] = { refused: false };
  } catch (err) {
    out[name] = {
      refused: err instanceof LegionRefuseError,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
