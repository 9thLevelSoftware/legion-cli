import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export type IngestFlags = {
  transcript?: string;
  diff?: string;
  commit?: boolean;
  distill?: boolean;
};

export async function runIngest(opts: CliOpts, sources: string[], flags: IngestFlags): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const receipt = await engine.ingest(sources, {
    noCommit: flags.commit === false,
    transcript: flags.transcript,
    diff: flags.diff,
    distill: Boolean(flags.distill),
  });

  if (opts.json) {
    writeJson(receipt);
    return 0;
  }

  writeOut(
    [
      `Ingest ${receipt.id}`,
      `created: ${receipt.pagesCreated.length}`,
      `updated: ${receipt.pagesUpdated.length}`,
      `skipped: ${receipt.skipped.length}`,
      receipt.pagesCreated.length > 0 ? `pages: ${receipt.pagesCreated.join(", ")}` : "",
      flags.commit === false ? "commit: skipped (--no-commit)" : "commit: wiki pages auto-committed on success",
      receipt.distillRan
        ? "distill: ran ingest skill (wiki pages remain untrusted)"
        : receipt.distillSkipped
          ? `distill: skipped (${receipt.distillSkipped})`
          : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
  return 0;
}
