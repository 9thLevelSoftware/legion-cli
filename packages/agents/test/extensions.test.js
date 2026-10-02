import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  findExtensionsDir,
  installExtensionOverlay,
  extensionReadSet,
  extensionCommandSpawnOpts,
  createExtensionRunId,
  listExtensionCatalog,
  parseExtensionFrontmatter,
  resolveExtensionDir,
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

test("all four packaged extension manifests are governed and discoverable", async () => {
  const listed = await listExtensionCatalog({ projectRoot: process.cwd(), packagedExtensionsDir: findExtensionsDir() });
  assert.deepEqual(
    listed.extensions.map((entry) => entry.ref).sort(),
    [
      "extension:accessibility",
      "extension:migration-rollback",
      "extension:performance",
      "extension:release-readiness",
    ],
  );
  assert.deepEqual(listed.skipped, []);
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
