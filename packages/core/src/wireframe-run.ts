import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  designPaths,
  extractCssVars,
  readActive,
  readPackageManifest,
} from "@9thlevelsoftware/legion-cli-design-system";
import type { Spec } from "@9thlevelsoftware/legion-cli-schema";
import { HINT, refuse } from "./errors.js";
import { clearSkipWireframesNote } from "./spec-build.js";
import type { OptionalSpawnResult } from "./spawn.js";
import type { WireframeOptions, WireframeResult } from "./types.js";
import {
  assertWireframeHtml,
  palettePresent,
  renderWireframeIndex,
  renderWireframeScreen,
  uniqueScreenPages,
  WIREFRAME_PALETTE,
  type ScreenPage,
} from "./wireframes.js";

const INDEX_NAME = "INDEX.html";
const WIREFRAMES_INDEX = "wireframes/INDEX.html";

const SHIPYARD_VARS: ReadonlyArray<{ name: string; alias: string; fallback: string }> = [
  { name: "--bg", alias: "--legion-bg", fallback: WIREFRAME_PALETTE.background },
  { name: "--ink", alias: "--legion-ink", fallback: WIREFRAME_PALETTE.ink },
  { name: "--accent", alias: "--legion-accent", fallback: WIREFRAME_PALETTE.accent },
  { name: "--muted", alias: "--legion-muted", fallback: WIREFRAME_PALETTE.muted },
];

export function screenPagesFor(screens: string[]): ScreenPage[] {
  const names = screens.length > 0 ? screens : ["home"];
  return uniqueScreenPages(names);
}

export function wireframeStorePath(specId: string, fileName: string): string {
  return `.legion-cli/specs/${specId}/wireframes/${fileName}`;
}

export function composeRestyleCss(tokensCss: string): string {
  const vars = extractCssVars(tokensCss);
  const mapping: string[] = [];
  for (const { name, alias, fallback } of SHIPYARD_VARS) {
    if (vars[name]) continue;
    mapping.push(vars[alias] ? `  ${name}: var(${alias});` : `  ${name}: ${fallback};`);
  }
  const mapBlock = mapping.length > 0 ? `\n:root {\n${mapping.join("\n")}\n}\n` : "\n";
  return `${tokensCss.trimEnd()}\n${mapBlock}`;
}

export function replaceStyleBlock(html: string, css: string): string {
  const block = `<style>\n${css.trimEnd()}\n</style>`;
  if (/<style\b[^>]*>[\s\S]*?<\/style>/i.test(html)) {
    return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/i, block);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `  ${block}\n</head>`);
  }
  return `${block}\n${html}`;
}

export async function writeWireframeFiles(
  dir: string,
  spec: Pick<Spec, "id" | "title">,
  pages: ScreenPage[],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, INDEX_NAME),
    renderWireframeIndex({ specTitle: spec.title, specId: spec.id, pages }),
    "utf8",
  );
  for (const page of pages) {
    await writeFile(
      join(dir, `${page.slug}.html`),
      renderWireframeScreen({
        specTitle: spec.title,
        screen: page.name,
        slug: page.slug,
        pages,
      }),
      "utf8",
    );
  }
}

export async function deleteStaleWireframePages(dir: string, pages: ScreenPage[]): Promise<void> {
  const keep = new Set([INDEX_NAME, ...pages.map((page) => `${page.slug}.html`)]);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".html")) continue;
    if (keep.has(name)) continue;
    await unlink(join(dir, name));
  }
}

export async function loadRestyleCss(projectRoot: string): Promise<string | null> {
  const active = await readActive(projectRoot);
  if (!active?.packageId) return null;
  const dir = designPaths(projectRoot).packageDir(active.packageId);
  let tokensFile: string;
  try {
    const manifest = await readPackageManifest(dir);
    tokensFile = manifest.files.tokens;
  } catch {
    refuse("active design-system package is missing tokens.css", HINT.designGenerate);
  }
  try {
    const tokensCss = await readFile(join(dir, tokensFile), "utf8");
    return composeRestyleCss(tokensCss);
  } catch {
    refuse("active design-system package is missing tokens.css", HINT.designGenerate);
  }
}

async function listHtmlFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((name) => name.toLowerCase().endsWith(".html"));
}

export async function snapshotHtmlDir(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of await listHtmlFiles(dir)) {
    out.set(name, await readFile(join(dir, name), "utf8"));
  }
  return out;
}

export async function restoreHtmlDir(dir: string, snap: ReadonlyMap<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const name of await listHtmlFiles(dir)) {
    if (!snap.has(name)) await unlink(join(dir, name));
  }
  for (const [name, html] of snap) {
    await writeFile(join(dir, name), html, "utf8");
  }
}

export function spawnWireframePrompt(specId: string, restyled: boolean): string {
  const palette = restyled
    ? "Brand tokens from the active design-system package win. Keep --bg/--ink/--accent/--muted mapped."
    : "Keep the palette: background #f5f5f0, ink #222, accent #c45c26, muted #888.";
  return [
    `Rewrite inner markup of HTML files in .legion-cli/specs/${specId}/wireframes/.`,
    "Leave INDEX.html as the index of screens.",
    "Do not write SPEC.md or anything outside the wireframes directory.",
    palette,
    "Do not add <script>, <iframe>, <object>, <embed>, on* event attributes, or javascript: URLs.",
    "When done, write a short summary to .legion-cli/cache/runs/<id>/summary.md.",
  ].join("\n");
}

async function restyleExisting(dir: string, css: string): Promise<void> {
  for (const name of await listHtmlFiles(dir)) {
    const abs = join(dir, name);
    const html = await readFile(abs, "utf8");
    await writeFile(abs, replaceStyleBlock(html, css), "utf8");
  }
}

function validateHtml(html: string, skipPalette: boolean): void {
  try {
    assertWireframeHtml(html);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    refuse(message, HINT.wireframe);
  }
  if (!skipPalette && !palettePresent(html)) {
    refuse("wireframe HTML is missing the 4-colour palette", HINT.wireframe);
  }
}

async function validateDir(dir: string, skipPalette: boolean): Promise<void> {
  const names = await listHtmlFiles(dir);
  if (names.length === 0) return;
  for (const name of names) {
    validateHtml(await readFile(join(dir, name), "utf8"), skipPalette);
  }
}

export type WireframeRunInput = {
  projectRoot: string;
  dir: string;
  spec: Spec;
  specBody: string;
  screens: string[];
  opts: WireframeOptions;
  writeSpec: (spec: Spec, body: string) => Promise<void>;
  spawnSkill?: (prompt: string) => Promise<OptionalSpawnResult>;
};

export async function runWireframe(input: WireframeRunInput): Promise<WireframeResult> {
  const spec = input.spec;
  const frozen = spec.status !== "draft";
  if (frozen && !input.opts.restyle) {
    refuse(
      "frozen spec is CSS-only; pass --restyle or start a new spec",
      HINT.wireframeRestyle,
    );
  }

  const pages = screenPagesFor(input.screens);
  const dir = input.dir;
  let restyled = false;

  if (!frozen) {
    await writeWireframeFiles(dir, spec, pages);
    await deleteStaleWireframePages(dir, pages);
    const nextIndex = spec.wireframesIndex ?? WIREFRAMES_INDEX;
    const cleared = clearSkipWireframesNote(input.specBody);
    if (nextIndex !== spec.wireframesIndex || cleared !== input.specBody) {
      await input.writeSpec({ ...spec, wireframesIndex: nextIndex, status: "draft" }, cleared);
    }
  }

  const restyleCss = input.opts.restyle ? await loadRestyleCss(input.projectRoot) : null;
  if (restyleCss) {
    await mkdir(dir, { recursive: true });
    await restyleExisting(dir, restyleCss);
    restyled = true;
  }

  const skipPalette = Boolean(input.opts.restyle && restyled);
  const snapshot = await snapshotHtmlDir(dir);

  if (input.opts.spawn && input.spawnSkill) {
    const spawned = await input.spawnSkill(spawnWireframePrompt(spec.id, restyled));
    let htmlFailed: unknown;
    try {
      await validateDir(dir, skipPalette);
    } catch (err) {
      htmlFailed = err;
      await restoreHtmlDir(dir, snapshot);
    }
    if (spawned.revert?.incident) {
      refuse("inspect .git — spawn touched .git/", HINT.wireframe);
    }
    if (spawned.revert && spawned.revert.extrasReverted.length > 0) {
      refuse(
        `spawn wrote files outside SkillContract; reverted: ${spawned.revert.extrasReverted.join(", ")}`,
        HINT.wireframe,
      );
    }
    if (htmlFailed) throw htmlFailed;
    if (spawned.error) throw spawned.error;
  } else {
    await validateDir(dir, skipPalette);
  }

  const existing = new Set(await listHtmlFiles(dir));
  const resultPages = pages
    .filter((page) => existing.has(`${page.slug}.html`))
    .map((page) => wireframeStorePath(spec.id, `${page.slug}.html`));

  return {
    specId: spec.id,
    status: spec.status === "draft" ? "draft" : "frozen",
    index: wireframeStorePath(spec.id, INDEX_NAME),
    pages: resultPages,
    restyled,
  };
}
