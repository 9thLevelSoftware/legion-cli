import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  COMPOSE_ORDER,
  CRAFT_SLUGS,
  DesignSystemError,
  composeDesignContext,
  copyShippedCraft,
  findCraftDir,
  generateFromBrief,
  importOpenDesign,
  installLocalDir,
  isBrandViolationBlockingFreeze,
  isGithubInstallSource,
  isRemoteInstallSource,
  mergeCssVars,
  showDesignSystem,
  threeLensReview,
} from "../dist/index.js";
import { initStub, legionFixture, odFixture, withTempDir } from "./helpers.js";

function isRefuse(err, message, hint) {
  assert.equal(err instanceof DesignSystemError, true, `expected DesignSystemError, got ${err?.name}: ${err?.message}`);
  if (message) assert.match(err.message, message);
  if (hint) assert.match(err.nextHint, hint);
  return true;
}

test("shipped craft slugs match the design", () => {
  assert.deepEqual([...CRAFT_SLUGS], [
    "typography",
    "color",
    "anti-ai-slop",
    "accessibility-baseline",
    "overflow-and-clipping",
  ]);
  const dir = findCraftDir();
  assert.ok(dir, "expected to find shipped craft/");
  for (const slug of CRAFT_SLUGS) {
    assert.equal(existsSync(join(dir, `${slug}.md`)), true, slug);
  }
});

test("compose order is USAGE → DESIGN → tokens → components → craft → skill", () => {
  assert.deepEqual([...COMPOSE_ORDER], ["usage", "design", "tokens", "components", "craft", "skill"]);
});

test("copyShippedCraft writes the five craft files", async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, "craft");
    const copied = await copyShippedCraft(dest);
    assert.deepEqual(copied, [...CRAFT_SLUGS]);
    assert.match(await readFile(join(dest, "typography.md"), "utf8"), /Typography/);
  });
});

test("github: sources are rejected", () => {
  assert.equal(isGithubInstallSource("github:acme/brand"), true);
  assert.equal(isGithubInstallSource("https://github.com/acme/brand"), true);
  assert.equal(isGithubInstallSource("//github.com/acme/brand"), true);
  assert.equal(isGithubInstallSource("\\\\github.com\\acme\\brand"), true);
  assert.equal(isGithubInstallSource("./brand"), false);
  assert.equal(isGithubInstallSource("./github.com/brand"), false);
});

test("protocol-relative, UNC, and URL schemes are remote", () => {
  for (const source of [
    "//example.com/brand.css",
    "\\\\example.com\\brand.css",
    "file:///tmp/brand",
    "ftp://example.com/brand",
    "git://example.com/brand",
    "ws://example.com/brand",
    "git@example.com:acme/brand",
  ]) {
    assert.equal(isRemoteInstallSource(source), true, source);
    assert.equal(isGithubInstallSource(source), false, source);
  }
  assert.equal(isRemoteInstallSource("C:\\\\Users\\\\brand"), false);
  assert.equal(isRemoteInstallSource("./brand"), false);
});

test("install rejects github:", async () => {
  await withTempDir(async (dir) => {
    await initStub(dir);
    await assert.rejects(
      () => installLocalDir({ projectRoot: dir, source: "github:acme/brand" }),
      (err) => isRefuse(err, /github:/, /local directory/),
    );
  });
});

test("install, import-od, and generate refuse UNC and protocol-relative paths before I/O", async () => {
  await withTempDir(async (dir) => {
    await initStub(dir);
    const githubPaths = ["//github.com/acme/brand", "\\\\github.com\\acme\\brand"];
    const other = "//example.com/brand.css";
    for (const source of githubPaths) {
      await assert.rejects(
        () => installLocalDir({ projectRoot: dir, source }),
        (err) => isRefuse(err, /github:/, /local directory/),
      );
      await assert.rejects(
        () => importOpenDesign({ projectRoot: dir, source }),
        (err) => isRefuse(err, /github:/, /local directory/),
      );
      await assert.rejects(
        () =>
          generateFromBrief({
            projectRoot: dir,
            brief: {
              name: "Checkin",
              workType: "product UI",
              platforms: "phone",
              wcag: "AA",
              brand: source,
            },
          }),
        (err) => isRefuse(err, /github:/, /path or none/),
      );
    }
    await assert.rejects(
      () => installLocalDir({ projectRoot: dir, source: other }),
      (err) => isRefuse(err, /local directory copy only/, /local directory/),
    );
    await assert.rejects(
      () => importOpenDesign({ projectRoot: dir, source: other }),
      (err) => isRefuse(err, /local directory copy only/, /local directory/),
    );
    await assert.rejects(
      () =>
        generateFromBrief({
          projectRoot: dir,
          brief: {
            name: "Checkin",
            workType: "product UI",
            platforms: "phone",
            wcag: "AA",
            brand: other,
          },
        }),
      (err) => isRefuse(err, /URL fetch/, /path or none/),
    );
  });
});

test("install rejects a raw OpenDesign folder", async () => {
  await withTempDir(async (dir) => {
    await initStub(dir);
    await assert.rejects(
      () => installLocalDir({ projectRoot: dir, source: odFixture }),
      (err) => isRefuse(err, /OpenDesign/, /import-od/),
    );
  });
});

test("import-od maps od-design-system-project/v1 to legion-cli-design-system/v1 (one-way)", async () => {
  await withTempDir(async (dir) => {
    await initStub(dir);
    const result = await importOpenDesign({ projectRoot: dir, source: odFixture });
    assert.equal(result.manifest.schemaVersion, "legion-cli-design-system/v1");
    assert.equal(result.manifest.id, "acme");
    assert.equal(result.manifest.source.type, "local");
    assert.equal(result.manifest.files.design, "DESIGN.md");
    assert.equal(result.manifest.files.tokens, "tokens.css");
    assert.equal(result.manifest.files.usage, "USAGE.md");
    assert.ok(result.manifest.integrity?.sha256);
    assert.equal("category" in result.manifest, false);
    const destManifest = JSON.parse(await readFile(join(result.dest, "manifest.json"), "utf8"));
    assert.equal(destManifest.schemaVersion, "legion-cli-design-system/v1");
    assert.match(await readFile(join(result.dest, "DESIGN.md"), "utf8"), /Acme/);
    const installed = await installLocalDir({ projectRoot: dir, source: result.dest });
    assert.equal(installed.id, "acme");
    const shown = await showDesignSystem(dir);
    assert.equal(shown.packageId, "acme");
  });
});

test("install copies a local Legion package and activates it", async () => {
  await withTempDir(async (dir) => {
    await initStub(dir);
    const result = await installLocalDir({ projectRoot: dir, source: legionFixture });
    assert.equal(result.id, "fixture-neutral");
    assert.equal(result.manifest.source.type, "local");
    const shown = await showDesignSystem(dir);
    assert.equal(shown.packageId, "fixture-neutral");
    assert.equal(shown.source.type, "local");
  });
});

test("brand tokens win over craft on compose", async () => {
  await withTempDir(async (dir) => {
    await initStub(dir);
    await copyShippedCraft(join(dir, ".legion-cli", "design", "craft"));
    await installLocalDir({ projectRoot: dir, source: legionFixture });
    const composed = await composeDesignContext({
      projectRoot: dir,
      skillBody: "Do the task.\n",
    });
    const slugs = composed.sections.map((s) => s.slug);
    assert.deepEqual(
      slugs.filter((s) => s !== "components"),
      ["usage", "design", "tokens", "craft", "skill"],
    );
    assert.ok(composed.overridden.includes("--legion-ink"));
    const tokens = composed.sections.find((s) => s.slug === "tokens");
    assert.match(tokens.body, /#111111/);
    assert.match(composed.text, /Brand tokens win/);
    assert.match(composed.text, /Do the task/);
  });
});

test("generate-from-brief refuses URL brand files", async () => {
  await withTempDir(async (dir) => {
    await initStub(dir);
    await assert.rejects(
      () =>
        generateFromBrief({
          projectRoot: dir,
          brief: {
            name: "Checkin",
            workType: "product UI",
            platforms: "phone and desktop",
            wcag: "AA",
            brand: "https://example.com/brand.css",
          },
        }),
      (err) => isRefuse(err, /URL fetch/, /path or none/),
    );
  });
});

test("generate-from-brief writes a package and three-lens review", async () => {
  await withTempDir(async (dir) => {
    await initStub(dir);
    const brand = join(dir, "brand.md");
    await writeFile(brand, "Ink #222222 on #f5f5f0. Accent #c45c26.\n", "utf8");
    const result = await generateFromBrief({
      projectRoot: dir,
      brief: {
        name: "Checkin",
        workType: "product UI",
        platforms: "phone and desktop",
        wcag: "AA",
        brand,
      },
    });
    assert.equal(result.id, "checkin");
    assert.equal(result.review.brandViolation, false);
    assert.equal(result.review.lenses.length, 3);
    assert.equal(result.manifest.wcag, "AA");
    assert.match(await readFile(join(result.dest, "tokens.css"), "utf8"), /#222222/);
    const shown = await showDesignSystem(dir);
    assert.equal(shown.packageId, "checkin");
    assert.equal(shown.brandViolation, false);
  });
});

test("install of a clean package clears prior generate brandViolation", async () => {
  await withTempDir(async (dir) => {
    await initStub(dir);
    const brand = join(dir, "brand.md");
    await writeFile(brand, ":root { --ink: blue; }\nPrimary #ff00aa\n", "utf8");
    const generated = await generateFromBrief({
      projectRoot: dir,
      brief: {
        name: "Checkin",
        workType: "product UI",
        platforms: "phone",
        wcag: "AA",
        brand,
      },
    });
    assert.equal(generated.review.brandViolation, true);
    assert.equal((await showDesignSystem(dir)).brandViolation, true);
    await installLocalDir({ projectRoot: dir, source: legionFixture });
    const shown = await showDesignSystem(dir);
    assert.equal(shown.packageId, "fixture-neutral");
    assert.equal(shown.brandViolation, false);
    assert.equal(
      await isBrandViolationBlockingFreeze(dir, { wireframesIndex: "wireframes/INDEX.html" }, []),
      false,
    );
  });
});

test("three-lens brand violation when brand colors are dropped", () => {
  const review = threeLensReview({
    workType: "product UI",
    platforms: "desktop",
    wcag: "AA",
    brand: "brand.md",
    designMd: "# Brand\n",
    tokensCss: ":root { --legion-ink: #000; }\n",
    brandFileText: "Primary #ff00aa\n",
  });
  assert.equal(review.brandViolation, true);
  assert.equal(review.lenses.find((l) => l.id === "brand").pass, false);
});

test("brand violation blocks UI spec freeze", async () => {
  await withTempDir(async (dir) => {
    await initStub(dir);
    await mkdir(join(dir, ".legion-cli", "design"), { recursive: true });
    await writeFile(
      join(dir, ".legion-cli", "design", "active.yaml"),
      "schemaVersion: legion-cli-design-active/v1\npackageId: checkin\ncraft: []\nbrandViolation: true\n",
      "utf8",
    );
    assert.equal(
      await isBrandViolationBlockingFreeze(dir, { wireframesIndex: "wireframes/INDEX.html" }, []),
      true,
    );
    assert.equal(await isBrandViolationBlockingFreeze(dir, {}, []), false);
  });
});

test("mergeCssVars lets brand win", () => {
  const { merged, overridden } = mergeCssVars(
    { "--legion-ink": "#222", "--legion-bg": "#f5f5f0" },
    { "--legion-ink": "#111111" },
  );
  assert.equal(merged["--legion-ink"], "#111111");
  assert.equal(merged["--legion-bg"], "#f5f5f0");
  assert.deepEqual(overridden, ["--legion-ink"]);
});
