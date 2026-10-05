import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  restoreEngineState,
  tryGitHead,
} from "@9thlevelsoftware/legion-cli-persist";
import type { SandboxApplyResult, SandboxOutput } from "@9thlevelsoftware/legion-cli-sandbox";
import { snapshotGitPolicy, type RevertResult } from "./revert.js";
import {
  updateResumeStage,
  type StartedSkillSpawn,
} from "./spawn.js";

type LiveStartedSpawn = Extract<StartedSkillSpawn, { spawned: true }>;

export type PreparedSandboxSpawn = {
  started: LiveStartedSpawn;
  output: SandboxOutput;
  revert: RevertResult;
};

function sameGitPolicy(
  left: Awaited<ReturnType<typeof snapshotGitPolicy>>,
  right: Awaited<ReturnType<typeof snapshotGitPolicy>>,
): boolean {
  return left.config === right.config && JSON.stringify(left.hooks) === JSON.stringify(right.hooks);
}

async function persistInspectedOutput(started: LiveStartedSpawn, output: SandboxOutput): Promise<void> {
  const root = join(
    started.revertCtx.projectRoot,
    ".legion-cli",
    "cache",
    "runs",
    started.runId,
    "integration",
  );
  await mkdir(root, { recursive: true });
  const manifest = [];
  for (const change of output.changes) {
    let stagedPath: string | undefined;
    if (change.action === "write" && change.content) {
      stagedPath = join("files", ...change.path.split("/"));
      const abs = join(root, stagedPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, change.content);
    }
    manifest.push({
      path: change.path,
      action: change.action,
      beforeHash: change.beforeHash,
      afterHash: change.afterHash,
      stagedPath,
    });
  }
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({ runId: started.runId, dropped: output.dropped, changes: manifest }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Inspect and seal one completed execute jail without touching product paths.
 * All batch members must be prepared before any member is applied.
 */
export async function prepareSandboxedSpawn(started: LiveStartedSpawn): Promise<PreparedSandboxSpawn> {
  if (!started.sandbox) throw new Error("parallel execute requires an individual sandbox jail");
  await updateResumeStage(started.revertCtx.projectRoot, started.runId, "integrating");
  const resumePath = join(
    started.revertCtx.projectRoot,
    ".legion-cli",
    "cache",
    "runs",
    started.runId,
    "resume.json",
  );
  let resumeRaw: string | undefined;
  try {
    resumeRaw = await readFile(resumePath, "utf8");
  } catch {
    resumeRaw = undefined;
  }
  const output = await started.sandbox.inspectOutput();
  await persistInspectedOutput(started, output);
  await started.sandbox.destroy();

  const currentPolicy = await snapshotGitPolicy(started.revertCtx.projectRoot);
  const gitPolicyChanged = !sameGitPolicy(started.revertCtx.gitPolicy, currentPolicy);
  const headNow = tryGitHead(started.revertCtx.projectRoot);
  const headMoved = (started.revertCtx.preSpawnRef ?? "UNBORN") !== (headNow ?? "UNBORN");
  const engine = await restoreEngineState(started.revertCtx.projectRoot, started.runId, {
    agentAlive: false,
    jailWritable: false,
    allowedRoots: started.revertCtx.allowedRoots,
  });
  if (resumeRaw !== undefined) {
    await writeFile(resumePath, resumeRaw, "utf8");
  }
  await updateResumeStage(started.revertCtx.projectRoot, started.runId, "integrating", {
    pid: null,
    pidStartedAt: null,
    childTerminationUncertain: false,
  });
  return {
    started,
    output,
    revert: {
      extrasReverted: [...output.dropped],
      incident: gitPolicyChanged || engine.tampered.length > 0 || engine.quarantined.length > 0,
      headMoved,
      preSpawnRef: started.revertCtx.preSpawnRef,
      sandboxCopied: [],
      sandboxDropped: [...output.dropped],
      engineRestored: [...engine.restored, ...engine.tampered, ...engine.reconciled],
      tamperIncident: engine.tampered.length > 0,
      filesHashed: engine.filesHashed,
    },
  };
}

export async function applyPreparedSandboxSpawn(
  prepared: PreparedSandboxSpawn,
  onApplied?: (paths: readonly string[]) => Promise<void>,
): Promise<SandboxApplyResult> {
  const sandbox = prepared.started.sandbox;
  if (!sandbox) throw new Error("parallel execute requires an individual sandbox jail");
  const result = await sandbox.applyOutput(prepared.output);
  if (result.copied.length > 0) await onApplied?.(result.copied);
  return result;

}

export async function discardPreparedSandboxSpawn(_prepared: PreparedSandboxSpawn): Promise<void> {
  // Ownership stays with the engine until it records the task's terminal state.
}
