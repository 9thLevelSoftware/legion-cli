import { createLegionEngine, HINT, refuse, type ShipPreview } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeErr, writeJson, writeOut } from "./io.js";
import { closePrompt, isNo, isYes, readLine, slurpStdin } from "./prompt.js";

export type ShipFlags = {
  allowDegradedQa?: boolean;
  pr?: boolean;
  commit?: boolean;
  bundle?: string;
};

export type ShipExportFlags = {
  snapshot: string;
  out: string;
};

export async function runShipExport(opts: CliOpts, flags: ShipExportFlags): Promise<number> {
  const engine = createLegionEngine(opts.project);
  const result = await engine.exportDeliverySnapshot(flags.snapshot, flags.out);
  if (opts.json) {
    writeJson({ ok: true, receipt: result });
  } else {
    writeOut(`Delivery snapshot ${result.snapshotId} exported to ${result.directory}`);
    writeOut(`Manifest SHA-256: ${result.manifestSha256}`);
    writeOut(`Public predicate SHA-256: ${result.predicateSha256} (predicate.json)`);
  }
  return 0;
}


async function confirmShip(preview: ShipPreview, json: boolean): Promise<boolean> {
  if (json) {
    writeErr(`Staged: ${preview.stagedDisplay}\n`);
    writeErr(`Unrelated files unchanged: ${preview.unrelatedUnchanged ? "yes" : "no"}\n`);
    if (preview.diff.trim()) writeErr(`${preview.diff.trimEnd()}\n`);
    writeErr("Acceptance criteria met?  [y/n] (an explicit y is required)\n");
  } else {
    writeOut(`Staged: ${preview.stagedDisplay}`);
    writeOut(`Unrelated files unchanged: ${preview.unrelatedUnchanged ? "yes" : "no"}`);
    writeOut(`QA missing: ${preview.qaCoverage.missing.join(", ") || "none"}`);
    writeOut(`QA failed: ${preview.qaCoverage.failed.join(", ") || "none"}`);
    writeOut(`QA skipped: ${preview.qaCoverage.skipped.join(", ") || "none"}`);
    if (preview.diff.trim()) writeOut(preview.diff.trimEnd());
    writeOut("Acceptance criteria met?  [y/n] (an explicit y is required)");
  }
  const answer = await readLine(json ? "" : "> ");
  if (isNo(answer)) return false;
  if (isYes(answer)) return true;
  if (answer === "") refuse("ship needs an explicit y (empty or closed input is not approval)", HINT.ship);
  refuse("ship needs y or n", HINT.ship);
}

export async function runShip(opts: CliOpts, flags: ShipFlags): Promise<number> {
  if (flags.bundle !== undefined && flags.bundle.trim() === "") {
    refuse("ship --bundle requires a non-empty directory", HINT.ship);
  }
  const engine = createLegionEngine(opts.project);
  try {
    await slurpStdin();
    const receipt = await engine.ship({
      allowDegradedQa: Boolean(flags.allowDegradedQa),
      commit: Boolean(flags.commit),
      pr: Boolean(flags.pr),
      ...(flags.bundle ? { bundleDirectory: flags.bundle } : {}),
      actor: "user",
      confirmSource: process.stdin.isTTY && process.stdout.isTTY ? "tty" : "piped",
      confirm: (preview) => confirmShip(preview, opts.json),
    });
    if (opts.json) {
      writeJson({
        ok: receipt.deliverySnapshot?.status !== "pending",
        receipt,
        next: "legion-cli spec new",
      });
      return receipt.deliverySnapshot?.status === "pending" ? 1 : 0;
    }
    if (receipt.deliverySnapshot?.status === "pending") {
      writeOut(`Delivery snapshot ${receipt.snapshotId ?? "(unknown)"} is pending: ${receipt.deliverySnapshot.error}`);
      writeOut(`Recovery: ${receipt.deliverySnapshot.recoveryHint}`);
    }
    writeOut("Ship receipt written. Next: legion-cli spec new");
    if (receipt.bundle?.status === "exported") {
      if (receipt.bundle.warning) writeOut(`Bundle warning: ${receipt.bundle.warning}`);
      writeOut(`Delivery bundle exported: ${receipt.bundle.path}`);
    } else if (receipt.bundle?.status === "failed") {
      writeOut(`Delivery bundle export failed: ${receipt.bundle.reason}`);
      writeOut(`Recover with: ${receipt.bundle.recoveryHint}`);
    }
    if (!flags.commit && receipt.staged.length > 0) writeOut("Changes are staged (not committed).");
    if (!flags.commit && !flags.pr) {
      writeOut("Optional: legion-cli ship --pr --commit");
    }
    if (receipt.committed && receipt.commitSha) {
      writeOut(`Commit: ${receipt.commitSha}`);
    }
    if (receipt.prUrl) {
      writeOut(`PR: ${receipt.prUrl}`);
    }
    return receipt.deliverySnapshot?.status === "pending" ? 1 : 0;
  } finally {
    closePrompt();
  }
}


