import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { detectSandbox } from "@9thlevelsoftware/legion-cli-sandbox";
import {
  findExtensionsDir,
  installExtensionOverlay,
  extensionReadSet,
  extensionCommandSpawnOpts,
  createExtensionRunId,
  listExtensionCatalog,
  parseExtensionFrontmatter,
  resolveExtensionDir,
  readComponentInvocation,
  runGovernedExtension,
} from "../dist/index.js";
import { withTempDir } from "./helpers.js";

function extensionMarkdown(id = "accessibility") {
  return [
    "---",
    `name: ${id}`,
    "description: Collect accessibility evidence and manual checks.",
    'compatibility: "Legion CLI >=0.0.0"',
    "allowed-tools: Read, Write, Bash(npx axe:*), Bash(npx playwright:*)",
    "metadata:",
    "  legion:",
    `    extensionId: ${id}`,
    "    version: 1.0.0",
    "    resources:",
    "      references: [references/checklist.md]",
    "    requiredTools: [node]",
    "    checks: [axe, keyboard]",
    "    permissions:",
    "      read: [src, test]",
    "      write: [.legion-cli/extensions/runs/**]",
    "      commands: [npx axe, npx playwright]",
    "---",
    "",
    `# ${id}`,
    "",
    "Unavailable checks must be recorded as unavailable, never passed.",
  ].join("\n");
}

test("extension frontmatter uses a separate extension identity and governed permissions", () => {
  const parsed = parseExtensionFrontmatter(
    extensionMarkdown(),
    "extensions/accessibility/EXTENSION.md",
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.manifest.ref, "extension:accessibility");
  assert.equal(parsed.manifest.extensionId, "accessibility");
  assert.deepEqual(parsed.manifest.permissions.write, [".legion-cli/extensions/runs/**"]);
  assert.deepEqual(parsed.manifest.requiredTools, ["node"]);
});

test("extension read set grants only declared roots plus engine-owned inputs", () => {
  const parsed = parseExtensionFrontmatter(
    extensionMarkdown().replace("read: [src, test]", "read: [src]"),
    "extensions/accessibility/EXTENSION.md",
  );
  assert.equal(parsed.ok, true);
  const readSet = extensionReadSet(parsed.manifest, "run-1");
  assert.equal(readSet.includes("src"), true);
  assert.equal(readSet.includes("package.json"), false);
  assert.deepEqual(readSet.slice(0, 2), [".legion-cli/cache/skills/run-1", ".legion-cli/cache/runs/run-1"]);
});

test("extension command wrapper denies network and drops wrappers that cannot", () => {
  const base = { cwd: "/jail", env: {}, wrapper: { bin: "bwrap", argvPrefix: ["--bind", "/jail", "/jail", "--",] } };
  const bwrap = extensionCommandSpawnOpts("bwrap", base);
  assert.deepEqual(bwrap.wrapper.argvPrefix.slice(-2), ["--unshare-net", "--"]);
  const seatbelt = extensionCommandSpawnOpts("seatbelt", { ...base, wrapper: { bin: "sandbox-exec", argvPrefix: ["-f", "profile", "--"] } });
  assert.equal(seatbelt.wrapper, undefined);
  const docker = extensionCommandSpawnOpts("docker", { ...base, wrapper: { bin: "docker", argvPrefix: ["run", "--network", "none", "image"] } });
  assert.equal(docker.wrapper.bin, "docker");
});

test("extension run ids remain distinct within the same millisecond", () => {
  const first = createExtensionRunId("accessibility", 1_800_000_000_000, "11111111-1111-4111-8111-111111111111");
  const second = createExtensionRunId("accessibility", 1_800_000_000_000, "22222222-2222-4222-8222-222222222222");
  assert.notEqual(first, second);
  assert.match(first, /^extension-accessibility-[a-z0-9]+-11111111-111/);
});

test("extension parser rejects core skill aliases and product-write permissions", () => {
  const core = parseExtensionFrontmatter(
    extensionMarkdown("execute"),
    "extensions/execute/EXTENSION.md",
  );
  assert.equal(core.ok, false);
  assert.match(core.reason, /core lifecycle skill/);

  const unsafe = parseExtensionFrontmatter(
    extensionMarkdown().replace("write: [.legion-cli/extensions/runs/**]", "write: [src/**]"),
    "extensions/accessibility/EXTENSION.md",
  );
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.reason, /evidence run root/);

  const unsupported = parseExtensionFrontmatter(
    extensionMarkdown().replace("Bash(npx axe:*)", "Bash(npx axe --help)"),
    "extensions/accessibility/EXTENSION.md",
  );
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.reason, /unsupported allowed-tools entry/);

  const mismatched = parseExtensionFrontmatter(
    extensionMarkdown().replace("commands: [npx axe, npx playwright]", "commands: [npx unrelated, npx playwright]"),
    "extensions/accessibility/EXTENSION.md",
  );
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.reason, /exactly match permissions.commands/);

  const widenedRead = parseExtensionFrontmatter(
    extensionMarkdown().replace("read: [src, test]", "read: [src/safe/*.ts, test]"),
    "extensions/accessibility/EXTENSION.md",
  );
  assert.equal(widenedRead.ok, false);
  assert.match(widenedRead.reason, /globs are not supported/);

  const missingCompatibility = parseExtensionFrontmatter(
    extensionMarkdown().replace('compatibility: "Legion CLI >=0.0.0"\n', ""),
    "extensions/accessibility/EXTENSION.md",
  );
  assert.equal(missingCompatibility.ok, false);
  assert.match(missingCompatibility.reason, /compatibility is required/);
});

test("missing declared resources fail install and governed execution", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "source", "accessibility");
    await mkdir(source, { recursive: true });
    const raw = extensionMarkdown().replace("references/checklist.md", "references/missing.md");
    await writeFile(join(source, "EXTENSION.md"), raw, "utf8");
    const parsed = parseExtensionFrontmatter(raw, "extensions/accessibility/EXTENSION.md");
    assert.equal(parsed.ok, true);
    await assert.rejects(
      () => installExtensionOverlay({ projectRoot: dir, source, extensionId: "accessibility", unsigned: true }),
      /declared resource is missing: references\/missing\.md/,
    );
    await assert.rejects(
      () => runGovernedExtension({
        projectRoot: dir,
        extensionDir: source,
        manifest: parsed.manifest,
        config: {
          adapter: { default: "fake" },
          sandbox: { backend: "copy", allowCopyJail: true, requireHardened: true },
        },
      }),
      /declared resource is missing: references\/missing\.md/,
    );
  });
});

test("catalog lists packaged extensions and pinned overlay wins", async () => {
  await withTempDir(async (dir) => {
    const packaged = join(dir, "extensions");
    const packagedDir = join(packaged, "accessibility");
    await mkdir(join(packagedDir, "references"), { recursive: true });
    await writeFile(join(packagedDir, "EXTENSION.md"), extensionMarkdown(), "utf8");
    await writeFile(join(packagedDir, "references", "checklist.md"), "# Checklist\n", "utf8");
    assert.equal(findExtensionsDir(packaged), packaged);
    const listed = await listExtensionCatalog({ projectRoot: dir, packagedExtensionsDir: packaged });
    assert.equal(listed.extensions.length, 1);
    assert.equal(listed.extensions[0].ref, "extension:accessibility");
    assert.deepEqual(listed.extensions[0].resources, ["references/checklist.md"]);

    const resolved = await resolveExtensionDir({
      projectRoot: dir,
      extensionId: "accessibility",
      packagedExtensionsDir: packaged,
    });
    assert.equal(resolved.ok, true);
    assert.equal(await readFile(join(resolved.extensionDir, "EXTENSION.md"), "utf8"), extensionMarkdown());
  });
});


test("governed extension run only copies evidence outputs and preserves unavailable checks", async () => {
  await withTempDir(async (dir) => {
    const extensionDir = join(dir, "extensions", "accessibility");
    await mkdir(join(extensionDir, "references"), { recursive: true });
    await writeFile(join(extensionDir, "EXTENSION.md"), extensionMarkdown(), "utf8");
    await writeFile(join(extensionDir, "references", "checklist.md"), "# Checklist\n", "utf8");
    const parsed = parseExtensionFrontmatter(extensionMarkdown(), "extensions/accessibility/EXTENSION.md");
    assert.equal(parsed.ok, true);
    const result = await runGovernedExtension({
      projectRoot: dir,
      extensionDir,
      manifest: parsed.manifest,
      config: {
        adapter: { default: "fake" },
        sandbox: { backend: "copy", allowCopyJail: true, requireHardened: true },
      },
      fakeArtifacts: [
        {
          path: ".legion-cli/extensions/runs/<id>/evidence.json",
          content: JSON.stringify({
            schemaVersion: "legion-cli-extension-evidence/v1",
            extension: "extension:accessibility",
            checks: [
              { id: "axe", status: "unavailable", detail: "playwright is not installed" },
              { id: "keyboard", status: "passed", detail: "tab order captured" },
            ],
          }),
        },
        {
          path: ".legion-cli/extensions/runs/<id>/recommendations.json",
          content: JSON.stringify({ recommendations: [{ title: "Add visible focus styles", priority: "P1" }] }),
        },
        { path: "src/escape.ts", content: "must not copy out\n" },
      ],
    });
    assert.equal(result.status, "complete");
    assert.equal(result.evidence.checks[0].status, "unavailable");
    assert.deepEqual(result.recommendations, [{ title: "Add visible focus styles", priority: "P1" }]);
    assert.equal(result.copied.some((path) => path.endsWith("evidence.json")), true);
    await assert.rejects(() => readFile(join(dir, "src", "escape.ts"), "utf8"), /ENOENT/);
  });
});

test("an in-process adapter extension run uses the detected hardened jail instead of refusing as copy", async (t) => {
  const detected = detectSandbox();
  if (!detected.hardened) {
    t.skip(`requires a hardened jail backend (detected ${process.platform}/${detected.backend})`);
    return;
  }
  await withTempDir(async (dir) => {
    const extensionDir = join(dir, "extensions", "accessibility");
    await mkdir(join(extensionDir, "references"), { recursive: true });
    await writeFile(join(extensionDir, "EXTENSION.md"), extensionMarkdown(), "utf8");
    await writeFile(join(extensionDir, "references", "checklist.md"), "# Checklist\n", "utf8");
    const parsed = parseExtensionFrontmatter(extensionMarkdown(), "extensions/accessibility/EXTENSION.md");
    assert.equal(parsed.ok, true);
    const result = await runGovernedExtension({
      projectRoot: dir,
      extensionDir,
      manifest: parsed.manifest,
      config: {
        adapter: { default: "fake" },
        sandbox: { backend: "auto", allowCopyJail: false, requireHardened: true },
      },
      fakeArtifacts: [{
        path: ".legion-cli/extensions/runs/<id>/evidence.json",
        content: JSON.stringify({
          schemaVersion: "legion-cli-extension-evidence/v1",
          extension: "extension:accessibility",
          checks: [
            { id: "axe", status: "passed", detail: "no violations" },
            { id: "keyboard", status: "passed", detail: "tab order captured" },
          ],
        }),
      }],
    });
    assert.equal(result.status, "complete");
    assert.equal(result.backend, detected.backend);
    const required = result.evidence.checks.filter((check) => !check.id.startsWith("tool:"));
    assert.deepEqual(required.map((check) => [check.id, check.status]), [["axe", "passed"], ["keyboard", "passed"]]);
    // Declared tools missing from this host's PATH are recorded as unavailable rather than dropped.
    for (const check of result.evidence.checks.filter((entry) => entry.id.startsWith("tool:"))) {
      assert.equal(check.status, "unavailable", JSON.stringify(check));
      assert.match(check.detail, /is not available on PATH$/);
    }
  });
});

test("concurrent governed runs started in one millisecond keep separate evidence roots", async () => {
  await withTempDir(async (dir) => {
    const extensionDir = join(dir, "extensions", "accessibility");
    await mkdir(join(extensionDir, "references"), { recursive: true });
    await writeFile(join(extensionDir, "EXTENSION.md"), extensionMarkdown(), "utf8");
    await writeFile(join(extensionDir, "references", "checklist.md"), "# Checklist\n", "utf8");
    const parsed = parseExtensionFrontmatter(extensionMarkdown(), "extensions/accessibility/EXTENSION.md");
    assert.equal(parsed.ok, true);
    const originalNow = Date.now;
    Date.now = () => 1_800_000_000_000;
    try {
      const run = () => runGovernedExtension({
        projectRoot: dir,
        extensionDir,
        manifest: parsed.manifest,
        config: {
          adapter: { default: "fake" },
          sandbox: { backend: "copy", allowCopyJail: true, requireHardened: true },
        },
        fakeArtifacts: [{
          path: ".legion-cli/extensions/runs/<id>/evidence.json",
          content: JSON.stringify({
            schemaVersion: "legion-cli-extension-evidence/v1",
            extension: "extension:accessibility",
            checks: [
              { id: "axe", status: "unavailable", detail: "fixture" },
              { id: "keyboard", status: "unavailable", detail: "fixture" },
            ],
          }),
        }],
      });
      const [first, second] = await Promise.all([run(), run()]);
      assert.notEqual(first.runId, second.runId);
      assert.notEqual(first.evidencePath, second.evidencePath);
      assert.equal(await readFile(join(dir, ...first.evidencePath.split("/")), "utf8").then(Boolean), true);
      assert.equal(await readFile(join(dir, ...second.evidencePath.split("/")), "utf8").then(Boolean), true);
    } finally {
      Date.now = originalNow;
    }
  });
});

test("extension admission refuses authority read grants even when forged after parsing", () => {
  const parsed = parseExtensionFrontmatter(extensionMarkdown(), "extensions/accessibility/EXTENSION.md");
  assert.equal(parsed.ok, true);
  for (const path of [
    ".legion-cli/workflow",
    ".LEGION-CLI/WORKFLOW/assurance.yaml",
    ".legion-cli/audit/governance",
    ".legion-cli/audit/http-governed",
    ".legion-cli/audit/delivery",
    ".legion-cli/audit/delivery-export",
    ".legion-cli/audit/raw-logs",
    ".legion-cli/audit",
    ".legion-cli",
  ]) {
    const manifest = parseExtensionFrontmatter(
      extensionMarkdown().replace("read: [src, test]", `read: [${path}]`),
      "extensions/accessibility/EXTENSION.md",
    );
    assert.equal(manifest.ok, false, path);
    assert.throws(() => extensionReadSet({
      ...parsed.manifest,
      permissions: { ...parsed.manifest.permissions, read: [path] },
    }, "run"), Error);
  }
  const legacy = parseExtensionFrontmatter(
    extensionMarkdown().replace("read: [src, test]", "read: [.legion-cli/wiki/product, .legion-cli/specs/spec-a/prd.md]"),
    "extensions/accessibility/EXTENSION.md",
  );
  assert.equal(legacy.ok, true);
  assert.equal(extensionReadSet(legacy.manifest, "run").includes(".legion-cli/wiki/product"), true);
});

test("runtime extension admission refuses junction read aliases before staging or adapter resolution", async (t) => {
  await withTempDir(async (dir) => {
    const extensionDir = join(dir, "extensions", "accessibility");
    await mkdir(join(extensionDir, "references"), { recursive: true });
    await writeFile(join(extensionDir, "references", "checklist.md"), "# Checklist\n");
    const workflow = join(dir, ".legion-cli", "workflow");
    await mkdir(workflow, { recursive: true });
    await writeFile(join(workflow, "assurance.yaml"), "authority\n");
    try {
      await symlink(workflow, join(dir, "inputs"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
      t.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    const parsed = parseExtensionFrontmatter(
      extensionMarkdown().replace("read: [src, test]", "read: [inputs]"),
      "extensions/accessibility/EXTENSION.md",
    );
    assert.equal(parsed.ok, true);
    await assert.rejects(runGovernedExtension({
      projectRoot: dir,
      extensionDir,
      manifest: parsed.manifest,
      config: { adapter: { default: "fake" }, sandbox: { backend: "copy", allowCopyJail: true } },
    }), { name: "PathEscapeError" });
    assert.equal(existsSync(join(dir, ".legion-cli", "cache")), false);
    assert.equal(await readFile(join(workflow, "assurance.yaml"), "utf8"), "authority\n");
  });
});

function componentMarkdown(hash, id = "json-contract") {
  return [
    "---",
    `name: ${id}`,
    "description: Validate declared JSON business predicates.",
    'compatibility: "Legion CLI >=0.0.0"',
    "allowed-tools: Read",
    "metadata:",
    "  legion:",
    `    extensionId: ${id}`,
    "    version: 1.0.0",
    "    requiredTools: []",
    `    checks: [${id}]`,
    "    resources:",
    "      assets: [assets/validator.wasm]",
    "    runtime:",
    "      kind: wasi-component",
    "      abi: legion-validator/v1",
    "      component: assets/validator.wasm",
    `      sha256: ${hash}`,
    "    permissions:",
    "      read: [data]",
    "      write: []",
    "      commands: []",
    "---",
    "Data-only JSON validation.",
  ].join("\n");
}

test("component frontmatter refuses ambient authority, undeclared modules, and ambiguous runtime fields", () => {
  const raw = componentMarkdown("a".repeat(64));
  for (const mutation of [
    raw.replace("abi: legion-validator/v1", "abi: another/v1"),
    raw.replace("component: assets/validator.wasm", "component: assets/undeclared.wasm"),
    raw.replace("component: assets/validator.wasm", "component: assets/../validator.wasm"),
    raw.replace("kind: wasi-component", "kind: wasi-component\n      extra: true"),
    raw.replace("description:", "unexpected: true\ndescription:"),
    raw.replace("allowed-tools: Read", "allowed-tools: Read\nallowedTools: Read"),
    raw.replace("assets: [assets/validator.wasm]", "assets: assets/validator.wasm"),
    raw.replace("read: [data]", "read: [data]\n      extra: true"),
    raw.replace("checks: [json-contract]", "checks: [json-contract, json-contract]"),
    raw.replace("checks: [json-contract]", "checks: [Invalid]"),
    raw.replace("allowed-tools: Read", "allowed-tools: Read, Write"),
    raw.replace("requiredTools: []", "requiredTools: [node]"),
    raw.replace("commands: []", "commands: [node]"),
    raw.replace("write: []", "write: [data]"),
  ]) {
    assert.equal(parseExtensionFrontmatter(mutation, "extensions/json-contract/SKILL.md").ok, false, mutation);
  }
});

test("validator invocation decoder rejects ambiguous, excessive, and non-finite control documents", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "invocation.json");
    const check = { id: "json-contract", configuration: {}, files: ["data/value.json"] };
    for (const raw of [
      '{"schemaVersion":"legion-cli-component-invocation/v1","schemaVersion":"legion-cli-component-invocation/v1","checks":[]}',
      JSON.stringify({ schemaVersion: "legion-cli-component-invocation/v1", checks: [check, check] }),
      JSON.stringify({ schemaVersion: "legion-cli-component-invocation/v1", checks: [{ ...check, files: ["data/value.json", "data/./value.json"] }] }),
      JSON.stringify({ schemaVersion: "legion-cli-component-invocation/v1", checks: [{ ...check, content: "embedded-source" }] }),
      '{"schemaVersion":"legion-cli-component-invocation/v1","checks":[{"id":"json-contract","configuration":{"n":1e400},"files":["data/value.json"]}]}',
      JSON.stringify({ schemaVersion: "legion-cli-component-invocation/v1", checks: [{ ...check, configuration: { n: [[[[]]]] } }] }).replace("[[[[]]]]", "[".repeat(33) + "0" + "]".repeat(33)),
      " ".repeat(1024 * 1024 + 1),
      Buffer.from([0xff, 0xfe]),
    ]) {
      await writeFile(path, raw);
      await assert.rejects(readComponentInvocation(path));
    }
  });
});

test("component admission rejects invalid invocation, profile, permissions, and JSON references before any host or adapter", async () => {
  await withTempDir(async (dir) => {
    const extensionDir = join(dir, "extension");
    const module = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    const hash = createHash("sha256").update(module).digest("hex");
    await mkdir(join(extensionDir, "assets"), { recursive: true });
    await mkdir(join(dir, "data"));
    await writeFile(join(extensionDir, "assets", "validator.wasm"), module);
    await writeFile(join(dir, "data", "value.json"), '{"value":42}');
    const parsed = parseExtensionFrontmatter(componentMarkdown(hash), "extensions/json-contract/SKILL.md");
    assert.equal(parsed.ok, true);
    const check = { id: "json-contract", files: ["data/value.json"], configuration: { assertions: [{ id: "value", predicate: { file: "data/value.json", pointer: "/value", op: "eq", expected: 42 } }] } };
    const invocation = { schemaVersion: "legion-cli-component-invocation/v1", checks: [check] };
    const opts = { projectRoot: dir, extensionDir, manifest: parsed.manifest, config: { adapter: { default: "claude", binary: "nonexistent-adapter" }, sandbox: { backend: "copy", allowCopyJail: false } } };
    const packet = {
      abi: "legion-validator/v1", projectCheckId: "project-one", extensionCheckId: "json-contract",
      acceptanceIds: [], unitIds: [], units: [], configuration: check.configuration,
      files: [{ kind: "file", path: "data/value.json", mode: "100644", encoding: "utf8", content: '{"value":42}', sha256: createHash("sha256").update('{"value":42}').digest("hex") }],
    };
    for (const [flags, pattern] of [
      [{}, /require.*validator-input/],
      [{ componentInvocation: invocation, profile: "unconfigured" }, /profile.*not supported/],
      [{ componentInvocation: { ...invocation, checks: [{ ...check, id: "other" }] } }, /each required/],
      [{ componentInvocation: { ...invocation, checks: [{ ...check, files: ["other/value.json"] }] } }, /outside permissions/],
      [{ componentInvocation: { ...invocation, checks: [{ ...check, configuration: { assertions: [{ id: "value", predicate: { file: "data/undeclared.json", pointer: "", op: "eq", expected: 42 } }] } }] } }, /undeclared raw input/],
      [{ componentInvocation: { ...invocation, checks: [{ ...check, configuration: { assertions: [{ id: "value", predicate: { file: "data/value.json", pointer: "", op: "eval", expected: 42 } }] } }] } }, /Invalid|invalid/],
      [{ approvedComponentInputs: [packet, { ...packet, projectCheckId: "project-two" }] }, /distinct project and extension/],
      [{ componentInvocation: invocation, approvedComponentInputs: [packet] }, /mutually exclusive/],
    ]) {
      await assert.rejects(runGovernedExtension({ ...opts, ...flags }), pattern);
      assert.equal(existsSync(join(dir, ".legion-cli", "extensions", "runs")), false);
      assert.equal(existsSync(join(dir, ".legion-cli", "cache")), false);
      assert.equal(await readFile(join(dir, "data", "value.json"), "utf8"), '{"value":42}');
    }
    await writeFile(join(extensionDir, "assets", "validator.wasm"), "tampered");
    await assert.rejects(runGovernedExtension({ ...opts, componentInvocation: invocation }), /SHA-256 mismatch/);
  });
});
