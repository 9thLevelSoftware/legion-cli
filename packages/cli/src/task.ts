import { createLegionEngine, HINT, refuse, type FileContract } from "@9thlevelsoftware/legion-cli-core";
import { resolvePersistAdapter } from "./adapter-route.js";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

export type TaskAmendFlags = {
  filesAllowed?: string[];
  verificationCommands?: string[];
  expectedArtifacts?: string[];
  blockedBy?: string[];
  blocks?: string[];
  allowDeps?: boolean;
  adapter?: string;
  route?: string;
  clearAdapter?: boolean;
  unblock?: boolean;
  recover?: boolean;
};

function splitList(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.flatMap((value) => value.split(",")).map((item) => item.trim()).filter(Boolean);
}

export async function runTaskAmend(opts: CliOpts, id: string, flags: TaskAmendFlags): Promise<number> {
  if (!id.trim()) {
    refuse("task amend requires a task id", HINT.amend);
  }
  if (flags.unblock && flags.recover) {
    refuse("unblock and recover are mutually exclusive", HINT.amend);
  }
  const engine = createLegionEngine(opts.project);
  if (flags.unblock) {
    const task = await engine.unblockTask(id);
    if (opts.json) {
      writeJson({ ok: true, id, status: task.status, next: "legion-cli next" });
      return 0;
    }
    writeOut(`Unblocked ${id} to ${task.status}.`);
    writeOut("Next: legion-cli next");
    return 0;
  }
  if (flags.recover) {
    const task = await engine.recoverTask(id);
    if (opts.json) {
      writeJson({ ok: true, id, status: task.status, next: "legion-cli task amend --unblock" });
      return 0;
    }
    writeOut(`Recovered ${id} to ${task.status}.`);
    writeOut("Next: legion-cli task amend --unblock");
    return 0;
  }
  const doc = await engine.store.readTask(id);
  const persisted = resolvePersistAdapter(await engine.store.readConfig(), flags);
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
    ...persisted,
  });
  if (opts.json) {
    writeJson({ ok: true, id, next: "legion-cli next" });
    return 0;
  }
  writeOut(`Amended ${id}.`);
  writeOut("Next: legion-cli next");
  return 0;
}
