import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertAgentControlPathAllowed,
  assertAgentPathAllowed,
  isEngineProtectedPath,
  overlapsEngineProtectedPath,
  PathEscapeError,
} from "../dist/index.js";

const controls = [
  ".legion-cli/workflow/assurance.yaml",
  ".legion-cli/workflow/assurance-approval.yaml",
  ".legion-cli/workflow/file-provenance.yaml",
  ".legion-cli/workflow/checks/business-check.yaml",
  ".legion-cli/workflow/assurance-execution.yaml",
  ".legion-cli/workflow/action-approvals/approval.yaml",
  ".legion-cli/audit/governance/epoch/head.json",
  ".legion-cli/audit/http-governed/run/http-governed-checkpoint.json",
  ".legion-cli/audit/http-governed/run/authority.json",
  ".legion-cli/audit/delivery/confirmation/outcome.yaml",
  ".legion-cli/audit/delivery-export/confirmation.json",
  ".legion-cli/audit/raw-logs/run/stdout.log",
];

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), "legion-protected-paths-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function linkDirectory(target, alias, t) {
  try {
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
    t.skip(`directory links unavailable: ${error.code}`);
    return false;
  }
}

test("authority controls and ancestor grants reject agent admission before files exist", async () => {
  await withTempDir(async (root) => {
    for (const path of controls) {
      assert.equal(isEngineProtectedPath(path), true, path);
      await assert.rejects(assertAgentPathAllowed(root, path), PathEscapeError);
    }
    for (const grant of [".legion-cli", ".legion-cli/audit", ".legion-cli/workflow", ".legion-cli/**", "**"]) {
      assert.equal(overlapsEngineProtectedPath(grant), true, grant);
    }
    await assert.rejects(assertAgentPathAllowed(root, ".legion-cli/audit"), PathEscapeError);
    for (const allowed of ["src/main.ts", ".legion-cli/wiki/product", ".legion-cli/tasks/task.md", ".legion-cli/specs/spec-a/prd.md", ".legion-cli/cache/runs/run", ".legion-cli/extensions/runs/run", ".legion-cli/audit/events.jsonl"]) {
      assert.equal(overlapsEngineProtectedPath(allowed), false, allowed);
      await assertAgentPathAllowed(root, allowed);
    }
  });
});

test("control protections cover Windows case, separators, trailing aliases and streams", () => {
  for (const path of [
    ".LEGION-CLI/WORKFLOW/assurance.yaml",
    ".legion-cli./workflow /assurance.yaml:$DATA",
    "LEGION~1/WORKFL~1/assurance.yaml",
    ".LEGION-CLI\\AUDIT\\HTTP-GOVERNED\\authority.json",
    ".legion-cli/audit/delivery./outcome.yaml",
  ]) {
    assert.equal(isEngineProtectedPath(path), true, path);
    assert.equal(overlapsEngineProtectedPath(path), true, path);
  }
  assert.equal(overlapsEngineProtectedPath(".legion-cli/audit/delivery-notes"), false);
  assert.equal(overlapsEngineProtectedPath(".legion-cli/workflow-notes"), false);
});

test("junction aliases cannot grant existing or future control files", async (t) => {
  await withTempDir(async (root) => {
    const workflow = join(root, ".legion-cli", "workflow");
    await mkdir(workflow, { recursive: true });
    await writeFile(join(workflow, "assurance.yaml"), "authority\n");
    if (!(await linkDirectory(workflow, join(root, "sources"), t))) return;
    await assert.rejects(assertAgentPathAllowed(root, "sources/assurance.yaml"), PathEscapeError);
    await assert.rejects(assertAgentPathAllowed(root, "sources/checks/future.yaml"), PathEscapeError);
    await assert.rejects(assertAgentPathAllowed(root, "sources"), PathEscapeError);
  });
});

test("a protected root junction also protects its product-visible destination", async (t) => {
  await withTempDir(async (root) => {
    const target = join(root, "src", "control");
    await mkdir(target, { recursive: true });
    await mkdir(join(root, ".legion-cli"));
    if (!(await linkDirectory(target, join(root, ".legion-cli", "workflow"), t))) return;
    await assert.rejects(assertAgentPathAllowed(root, "src/control/assurance.yaml"), PathEscapeError);
    await assert.rejects(assertAgentPathAllowed(root, "src"), PathEscapeError);
    await assertAgentPathAllowed(root, "src/product/main.ts");
  });
});

test("control-only admission distinguishes outside product aliases from outside authority aliases", async (t) => {
  await withTempDir(async (root) => {
    await withTempDir(async (outside) => {
      await writeFile(join(outside, "data.json"), '{"product":true}\n');
      if (!(await linkDirectory(outside, join(root, "sources"), t))) return;
      await assertAgentControlPathAllowed(root, "sources/data.json");
      await assert.rejects(assertAgentPathAllowed(root, "sources/data.json"), PathEscapeError);
      await mkdir(join(root, ".legion-cli"));
      if (!(await linkDirectory(outside, join(root, ".legion-cli", "workflow"), t))) return;
      await assert.rejects(assertAgentControlPathAllowed(root, "sources/data.json"), PathEscapeError);
      await assert.rejects(assertAgentControlPathAllowed(root, "sources/checks/future.yaml"), PathEscapeError);
      await assert.rejects(assertAgentControlPathAllowed(root, "sources"), PathEscapeError);
      await assert.rejects(assertAgentControlPathAllowed(root, ".legion-cli/workflow"), PathEscapeError);
    });
  });
});

test("both shared guards deny engine regular-file hardlinks throughout the authority trees", async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, "src"));
    for (const [index, control] of controls.entries()) {
      const parent = control.slice(0, control.lastIndexOf("/"));
      await mkdir(join(root, parent), { recursive: true });
      await writeFile(join(root, control), `authority-${index}\n`);
      const alias = `src/control-${index}.txt`;
      await link(join(root, control), join(root, alias));
      await assert.rejects(assertAgentPathAllowed(root, alias), PathEscapeError);
      await assert.rejects(assertAgentControlPathAllowed(root, alias), PathEscapeError);
    }
  });
});

test("ordinary hardlinks and new write targets stay allowed, and authority identities are never cached", async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".legion-cli", "workflow"), { recursive: true });
    await writeFile(join(root, "src", "data.txt"), "ordinary product\n");
    await link(join(root, "src", "data.txt"), join(root, "src", "copy.txt"));
    for (const guard of [assertAgentPathAllowed, assertAgentControlPathAllowed]) {
      await guard(root, "src/data.txt");
      await guard(root, "src/copy.txt");
      await guard(root, "src/future.txt");
    }
    assert.equal(await readFile(join(root, "src", "copy.txt"), "utf8"), "ordinary product\n");
    const authority = join(root, ".legion-cli", "workflow", "assurance.yaml");
    await link(join(root, "src", "data.txt"), authority);
    for (const guard of [assertAgentPathAllowed, assertAgentControlPathAllowed]) {
      await assert.rejects(guard(root, "src/data.txt"), PathEscapeError);
      await assert.rejects(guard(root, "src/copy.txt"), PathEscapeError);
    }
    await rm(authority);
    await assertAgentPathAllowed(root, "src/copy.txt");
    await assertAgentControlPathAllowed(root, "src/copy.txt");
  });
});

test("hardlink inspection compares actual file identity rather than identical contents", async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".legion-cli", "workflow"), { recursive: true });
    await writeFile(join(root, ".legion-cli", "workflow", "assurance.yaml"), "same bytes\n");
    await writeFile(join(root, "src", "data.txt"), "same bytes\n");
    await link(join(root, "src", "data.txt"), join(root, "src", "copy.txt"));
    await assertAgentPathAllowed(root, "src/copy.txt");
    await assertAgentControlPathAllowed(root, "src/copy.txt");
  });
});

test("hardlink inspection fails closed on nested authority directory cycles and external links without walking them", async (t) => {
  await withTempDir(async (root) => {
    await withTempDir(async (outside) => {
      const workflow = join(root, ".legion-cli", "workflow");
      await mkdir(workflow, { recursive: true });
      await writeFile(join(root, "product.txt"), "ordinary\n");
      await link(join(root, "product.txt"), join(root, "product-copy.txt"));
      await writeFile(join(root, "single-link.txt"), "single\n");
      for (const destination of [workflow, outside]) {
        const alias = join(workflow, "nested");
        if (!(await linkDirectory(destination, alias, t))) return;
        await assert.rejects(assertAgentPathAllowed(root, "product-copy.txt"), PathEscapeError);
        await assert.rejects(assertAgentControlPathAllowed(root, "product-copy.txt"), PathEscapeError);
        await assertAgentPathAllowed(root, "single-link.txt");
        await rm(alias);
      }
    });
  });
});

test("hardlink inspection bounds deeply nested authority inventories", async () => {
  await withTempDir(async (root) => {
    let current = join(root, ".legion-cli", "workflow");
    await mkdir(current, { recursive: true });
    for (let depth = 0; depth < 65; depth++) {
      current = join(current, "d");
      await mkdir(current);
    }
    await writeFile(join(root, "product.txt"), "ordinary\n");
    await link(join(root, "product.txt"), join(root, "product-copy.txt"));
    await assert.rejects(assertAgentPathAllowed(root, "product-copy.txt"), PathEscapeError);
    await assert.rejects(assertAgentControlPathAllowed(root, "product-copy.txt"), PathEscapeError);
  });
});

test("hardlinks to a protected root's resolved destination are denied", async (t) => {
  await withTempDir(async (root) => {
    const destination = join(root, "src", "control");
    await mkdir(destination, { recursive: true });
    await mkdir(join(root, ".legion-cli"));
    await writeFile(join(destination, "assurance.yaml"), "authority\n");
    if (!(await linkDirectory(destination, join(root, ".legion-cli", "workflow"), t))) return;
    await link(join(destination, "assurance.yaml"), join(root, "exposed.txt"));
    await assert.rejects(assertAgentPathAllowed(root, "exposed.txt"), PathEscapeError);
    await assert.rejects(assertAgentControlPathAllowed(root, "exposed.txt"), PathEscapeError);
  });
});

test("control-only hardlink admission preserves external sparse aliases unless their identity is authority", async (t) => {
  await withTempDir(async (root) => {
    await withTempDir(async (outside) => {
      await writeFile(join(outside, "product.txt"), "ordinary external product\n");
      await link(join(outside, "product.txt"), join(outside, "product-copy.txt"));
      if (!(await linkDirectory(outside, join(root, "sources"), t))) return;
      await assertAgentControlPathAllowed(root, "sources/product-copy.txt");
      await assert.rejects(assertAgentPathAllowed(root, "sources/product-copy.txt"), PathEscapeError);
      await mkdir(join(root, ".legion-cli", "workflow"), { recursive: true });
      await link(join(outside, "product.txt"), join(root, ".legion-cli", "workflow", "assurance.yaml"));
      await assert.rejects(assertAgentControlPathAllowed(root, "sources/product-copy.txt"), PathEscapeError);
    });
  });
});
