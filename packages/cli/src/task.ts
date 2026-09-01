import { createLegionEngine, HINT, refuse, type FileContract } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export type TaskAmendFlags = {
  filesAllowed?: string[];
  verificationCommands?: string[];
  expectedArtifacts?: string[];
  blockedBy?: string[];
  blocks?: string[];
  allowDeps?: boolean;
};

function splitList(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.flatMap((value) => value.split(",")).map((item) => item.trim()).filter(Boolean);
}

export async function runTaskAmend(opts: CliOpts, id: string, flags: TaskAmendFlags): Promise<number> {
  if (!id.trim()) {
    refuse("task amend requires a task id", HINT.amend);
  }
  const engine = createLegionEngine(opts.project);
  const doc = await engine.store.readTask(id);
  const filesAllowed = splitList(flags.filesAllowed) ?? doc.data.contract.filesAllowed;
  const verificationCommands = splitList(flags.verificationCommands) ?? doc.data.contract.verificationCommands;
  const expectedArtifacts = splitList(flags.expectedArtifacts) ?? doc.data.contract.expectedArtifacts;
  const contract: FileContract = {
    ...doc.data.contract,
    filesAllowed,
    verificationCommands,
    expectedArtifacts,
  };
  await engine.amendTask(id, contract, {
    allowDeps: Boolean(flags.allowDeps),
    blockedBy: splitList(flags.blockedBy),
    blocks: splitList(flags.blocks),
  });
  if (opts.json) {
    writeJson({ ok: true, id, next: "legion-cli next" });
    return 0;
  }
  writeOut(`Amended ${id}.`);
  writeOut("Next: legion-cli next");
  return 0;
}
