import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bindKnowledgeUnit } from "../dist/index.js";
import { withTempDir, writeTree } from "./helpers.js";

function unit(kind, qualifiedName, path = "src/unit.ts") {
  return { id: "business-rule", statement: "The delivered business rule is satisfied", source: { path, ...(kind ? { selector: { kind, qualifiedName } } : {}) }, acceptanceIds: ["AC-1"], taskIds: [], dependsOn: [], checkIds: [] };
}

async function bound(root, selection) {
  const result = await bindKnowledgeUnit(root, selection);
  assert.equal(result.status, "bound", result.status === "unknown" ? result.reason : "");
  return result;
}

async function digestFor(root, selection, content) {
  await writeTree(root, { [selection.source.path]: content });
  return bound(root, selection);
}

test("qualified namespace, nested function and all declaration kinds bind without suffix matching", async () => {
  await withTempDir(async (root) => {
    await writeTree(root, { "src/unit.ts": `namespace Rules.Inner {
      export function outer() { function local() { return 7; } return local(); }
      export class Engine { evaluate(value: number): number { return value + 1; } }
      export interface Policy { value: number; evaluate(value: number): number; }
      export type Result = { ok: boolean };
      export const threshold = 7;
    }
    function local() { return 999; }
    ` });
    for (const [kind, name] of [["function", "Rules.Inner.outer.local"], ["class", "Rules.Inner.Engine"], ["method", "Rules.Inner.Engine.evaluate"], ["method", "Rules.Inner.Policy.evaluate"], ["interface", "Rules.Inner.Policy"], ["type", "Rules.Inner.Result"], ["variable", "Rules.Inner.threshold"]]) {
      const result = await bound(root, unit(kind, name));
      assert.equal(result.parserVersion, "typescript@5.8.3");
    }
    const missing = await bindKnowledgeUnit(root, unit("function", "Inner.outer.local"));
    assert.equal(missing.status, "unknown");
    assert.match(missing.reason, /not found/i);
  });
});

test("complete overload groups bind every signature and reject duplicates or ambiguous scopes", async () => {
  await withTempDir(async (root) => {
    const selection = unit("function", "Rules.evaluate");
    const before = await digestFor(root, selection, `namespace Rules {
      export function evaluate(value: string): string;
      export function evaluate(value: number): number;
      export function evaluate(value: string | number) { return value; }
    }`);
    const after = await digestFor(root, selection, `namespace Rules {
      export function evaluate(value: boolean): boolean;
      export function evaluate(value: number): number;
      export function evaluate(value: boolean | number) { return value; }
    }`);
    assert.notEqual(before.input.syntaxDigest, after.input.syntaxDigest);
    for (const [source, reason] of [
      ["namespace Rules { function evaluate() {} function evaluate() {} }", /duplicate.*implementation/i],
      ["namespace Rules { function evaluate(value: number): number; }", /without implementation/i],
      ["namespace Rules { function evaluate(value: number): number; const gap = 0; function evaluate(value: number) { return value; } }", /noncontiguous/i],
      ["namespace Rules { { function evaluate() {} } { function evaluate() {} } }", /ambiguous.*scope/i],
      ["declare namespace Rules { function evaluate() {} }", /cannot have an implementation/i],
    ]) {
      await writeTree(root, { "src/unit.ts": source });
      const result = await bindKnowledgeUnit(root, selection);
      assert.equal(result.status, "unknown");
      assert.match(result.reason, reason);
      assert.equal(result.source.sha256, createHash("sha256").update(source).digest("hex"));
      assert.ok(result.source.mode);
    }
    await writeTree(root, { "src/unit.ts": "class Engine { evaluate() { return 1; } } class Engine {}" });
    const duplicateScope = await bindKnowledgeUnit(root, unit("method", "Engine.evaluate"));
    assert.equal(duplicateScope.status, "unknown");
    assert.match(duplicateScope.reason, /ambiguous qualified scope/i);
    await writeTree(root, { "src/unit.ts": "class Engine { evaluate(value: string): string; evaluate(value: number): number; evaluate(value: string | number) { return value; } }" });
    await bound(root, unit("method", "Engine.evaluate"));
    await writeTree(root, { "src/unit.ts": "declare namespace Rules { function evaluate(value: number): number; function evaluate(value: string): string; }" });
    await bound(root, selection);
    await writeTree(root, { "src/unit.ts": "abstract class Engine { abstract evaluate(value: number): number; }" });
    await bound(root, unit("method", "Engine.evaluate"));
    await writeTree(root, { "src/unit.ts": "class Engine { static evaluate() { return 1; } evaluate() { return 2; } }" });
    const staticAndInstance = await bindKnowledgeUnit(root, unit("method", "Engine.evaluate"));
    assert.equal(staticAndInstance.status, "unknown");
    assert.match(staticAndInstance.reason, /static\/instance/i);
  });
});

test("renamed declarations, missing source and parse errors remain unknown with observed identities", async () => {
  await withTempDir(async (root) => {
    const selection = unit("function", "approved");
    await digestFor(root, selection, "export function approved() { return 1; }");
    const renamed = "export function replacement() { return 1; }";
    await writeTree(root, { "src/unit.ts": renamed });
    const absentDeclaration = await bindKnowledgeUnit(root, selection);
    assert.equal(absentDeclaration.status, "unknown");
    assert.match(absentDeclaration.reason, /not found/i);
    assert.equal(absentDeclaration.source.sha256, createHash("sha256").update(renamed).digest("hex"));
    await rename(join(root, "src/unit.ts"), join(root, "src/renamed.ts"));
    const absentFile = await bindKnowledgeUnit(root, selection);
    assert.equal(absentFile.status, "unknown");
    assert.equal(absentFile.source.sha256, null);
    await writeTree(root, { "src/unit.ts": "function approved( { return 1; }" });
    const invalid = await bindKnowledgeUnit(root, selection);
    assert.equal(invalid.status, "unknown");
    assert.match(invalid.reason, /parse error/i);
    assert.ok(invalid.source.sha256);
  });
});

test("comment-only edits normalize but ASI changes and different AST property roles do not", async () => {
  await withTempDir(async (root) => {
    const selection = unit("function", "evaluate");
    const original = await digestFor(root, selection, "function evaluate() { return 7; }");
    const comment = await digestFor(root, selection, "// unrelated\nfunction evaluate( /* note */ ) { /* note */ return /* value */ 7; }");
    assert.equal(original.input.syntaxDigest, comment.input.syntaxDigest);
    assert.notEqual(original.source.sha256, comment.source.sha256);
    const asi = await digestFor(root, selection, "function evaluate() { return\n7; }");
    assert.notEqual(original.input.syntaxDigest, asi.input.syntaxDigest);
    const condition = await digestFor(root, selection, "function evaluate() { for (; value;) {} }");
    const increment = await digestFor(root, selection, "function evaluate() { for (;; value) {} }");
    assert.notEqual(condition.input.syntaxDigest, increment.input.syntaxDigest);
    const object = await digestFor(root, selection, "function evaluate() { return { value: 7 }; }");
    const multilineComment = await digestFor(root, selection, "function evaluate() { return { /* explanatory\n comment */ value: 7 }; }");
    assert.equal(object.input.syntaxDigest, multilineComment.input.syntaxDigest);
  });
});

test("variable declaration context, literal spelling and raw templates retain distinct identities", async () => {
  await withTempDir(async (root) => {
    const selection = unit("variable", "value");
    const constValue = await digestFor(root, selection, "export const value = 1;");
    const letValue = await digestFor(root, selection, "export let value = 1;");
    const varValue = await digestFor(root, selection, "export var value = 1;");
    assert.notEqual(constValue.input.syntaxDigest, letValue.input.syntaxDigest);
    assert.notEqual(letValue.input.syntaxDigest, varValue.input.syntaxDigest);
    for (const [left, right] of [
      ["const value = 1;", "const value = 0x1;"],
      ['const value = "a";', 'const value = "\\u0061";'],
      ["const value = /a/i;", "const value = /a/g;"],
      ["const value = String.raw`a\\nb`;", "const value = String.raw`a\nb`;"],
      ["const value = `a${1}b`;", "const value = `a${2}b`;"],
    ]) {
      const first = await digestFor(root, selection, left);
      const second = await digestFor(root, selection, right);
      assert.notEqual(first.input.syntaxDigest, second.input.syntaxDigest);
    }
    const jsx = unit("variable", "value", "src/unit.tsx");
    const spaced = await digestFor(root, jsx, "const value = <span>a b</span>;");
    const unspaced = await digestFor(root, jsx, "const value = <span>ab</span>;");
    assert.notEqual(spaced.input.syntaxDigest, unspaced.input.syntaxDigest);
  });
});

test("deep selected syntax stays complete in a shallow projection", async () => {
  await withTempDir(async (root) => {
    const selection = unit("function", "evaluate");
    const expression = "1 + (".repeat(100) + "2" + ")".repeat(100);
    const before = await digestFor(root, selection, `function evaluate() { return ${expression}; }`);
    const changed = "1 + (".repeat(100) + "3" + ")".repeat(100);
    const after = await digestFor(root, selection, `function evaluate() { return ${changed}; }`);
    assert.notEqual(before.input.syntaxDigest, after.input.syntaxDigest);
  });
});

test("whole-file bindings preserve binary bytes and raw comments without a parser identity", async () => {
  await withTempDir(async (root) => {
    const selection = unit(undefined, undefined, "input.bin");
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    await writeFile(join(root, "input.bin"), bytes);
    const result = await bound(root, selection);
    assert.equal(result.parserVersion, null);
    assert.equal(result.source.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.input.syntaxProjection.encoding, "base64");
    assert.deepEqual(Buffer.from(result.input.syntaxProjection.content, "base64"), bytes);
    const textSelection = unit(undefined, undefined);
    const before = await digestFor(root, textSelection, "const value = 1;\n");
    const after = await digestFor(root, textSelection, "// comment\nconst value = 1;\n");
    assert.notEqual(before.input.syntaxDigest, after.input.syntaxDigest);
  });
});

test("protected and linked sources never become bound input", async (t) => {
  await withTempDir(async (root) => {
    await writeTree(root, { ".legion-cli/workflow/control.json": '{"authority":true}', "src/unit.ts": "function evaluate() { return 1; }" });
    const protectedSource = await bindKnowledgeUnit(root, unit(undefined, undefined, ".legion-cli/workflow/control.json"));
    assert.equal(protectedSource.status, "unknown");
    assert.equal(protectedSource.source.sha256, null);
    try { await symlink(join(root, "src"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP") { t.diagnostic("Directory links unavailable; direct protected-source denial exercised"); return; }
      throw error;
    }
    const linkedSource = await bindKnowledgeUnit(root, unit("function", "evaluate", "alias/unit.ts"));
    assert.equal(linkedSource.status, "unknown");
    assert.equal(linkedSource.source.sha256, null);
    await rm(join(root, ".legion-cli/workflow"), { recursive: true });
    await symlink(join(root, "src"), join(root, ".legion-cli/workflow"), process.platform === "win32" ? "junction" : "dir");
    const physicalControlAlias = await bindKnowledgeUnit(root, unit("function", "evaluate"));
    assert.equal(physicalControlAlias.status, "unknown");
    assert.equal(physicalControlAlias.source.sha256, null);
  });
});

test("regular-file mode is retained separately from normalized syntax", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (root) => {
    const selection = unit("function", "evaluate");
    await writeTree(root, { "src/unit.ts": "function evaluate() { return 1; }" });
    await chmod(join(root, "src/unit.ts"), 0o644);
    const before = await bound(root, selection);
    await chmod(join(root, "src/unit.ts"), 0o755);
    const after = await bound(root, selection);
    assert.equal(before.source.mode, "100644");
    assert.equal(after.source.mode, "100755");
    assert.equal(before.input.syntaxDigest, after.input.syntaxDigest);
  });
});
