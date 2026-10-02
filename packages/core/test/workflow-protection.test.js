import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { isAllowedPath, isImplicitForbidden } from "../dist/index.js";
import { engineSotRefuseReason, httpAllowedWrites } from "../dist/http-host.js";
import { isPinnedEngineSot, isRestoreManifestPath, openEngineCommand, restoreEngineState } from "@9thlevelsoftware/legion-cli-persist";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

test("agents cannot write workflow approval or evidence receipts", () => {
  for (const path of [".legion-cli/map/selection.json", ".legion-cli/workflow", ".legion-cli/workflow/plan-approval.yaml", ".legion-cli/workflow/execution.yaml", ".legion-cli/workflow/spec-challenge-spec-example.yaml", ".legion-cli/workflow/spec-challenge-spec-example.thinking.md"]) {
    assert.equal(isImplicitForbidden(path), true);
    assert.equal(isAllowedPath(path, [".legion-cli/**"]), false);
    assert.match(engineSotRefuseReason(path), /engine-SoT refused/);
    assert.equal(isPinnedEngineSot(path), true);
    assert.equal(isRestoreManifestPath(path), true);
  }
  assert.deepEqual(httpAllowedWrites([".legion-cli/workflow/acceptance.yaml", "src/main.ts"]), ["src/main.ts"]);
});

test("spawn rollback restores receipt tampering even with broad allowed roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legion-workflow-protection-"));
  try {
    await mkdir(join(dir, ".legion-cli", "workflow"), { recursive: true });
    for (const name of ["plan-approval.yaml", "spec-challenge-spec-example.yaml"]) {
      const receipt = join(dir, ".legion-cli", "workflow", name);
      await writeFile(receipt, "approvedBy: user\n");
      const command = await openEngineCommand(dir, `review-protection-${name}`, { extraRoots: [".legion-cli/**"] });
      await writeFile(receipt, "approvedBy: agent\n");
      await restoreEngineState(dir, command.id, { agentAlive: false, jailWritable: false, allowedRoots: [".legion-cli/**"] });
      assert.equal(await readFile(receipt, "utf8"), "approvedBy: user\n");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
