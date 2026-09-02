import { createLegionEngine } from "@9thlevelsoftware/legion-cli-core";
import type { GardenReport } from "@9thlevelsoftware/legion-cli-wiki";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

function formatGarden(report: GardenReport): string {
  const lines = ["Wiki garden (report only; nothing deleted)", ""];

  lines.push("Orphans (no inbound links):");
  if (report.orphans.length === 0) {
    lines.push("  (none)");
  } else {
    for (const page of report.orphans) {
      lines.push(`  ${page.id}  ${page.title}  ${page.path}`);
    }
  }

  lines.push("");
  lines.push("Likely duplicates (similar titles):");
  if (report.duplicates.length === 0) {
    lines.push("  (none)");
  } else {
    for (const group of report.duplicates) {
      const titles = group.pages.map((page) => `${page.title} (${page.path})`);
      lines.push(`  - ${titles.join(" / ")}`);
    }
  }

  lines.push("");
  lines.push("Stale untrusted:");
  if (report.staleUntrusted.length === 0) {
    lines.push("  (none)");
  } else {
    for (const page of report.staleUntrusted) {
      const when = page.updatedAt ? `  ${page.updatedAt}` : "";
      lines.push(`  ${page.id}  ${page.title}  untrusted${when}`);
    }
  }

  return lines.join("\n");
}

export async function runGarden(opts: CliOpts): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const report = await engine.garden();
  if (opts.json) {
    writeJson({ ...report, deleted: false });
    return 0;
  }
  writeOut(formatGarden(report));
  return 0;
}
