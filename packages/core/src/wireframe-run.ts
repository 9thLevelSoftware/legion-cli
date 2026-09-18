import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  designPaths,
  extractCssVars,
  readActive,
  readPackageManifest,
} from "@9thlevelsoftware/legion-cli-design-system";
import type { Spec } from "@9thlevelsoftware/legion-cli-schema";
import { HINT, refuse } from "./errors.js";
import { clearSkipWireframesNote } from "./spec-build.js";
import type { RevertResult } from "./revert.js";
import type { WireframeOptions, WireframeResult } from "./types.js";
import {
  assertWireframeHtml,
  palettePresent,
  renderWireframeIndex,
  renderWireframeScreen,
  uniqueScreenPages,
  WIREFRAME_CSS,
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

function wireframeStorePath(specId: string, fileName: string): string {
  return `.legion-cli/specs/${specId}/wireframes/${fileName}`;
}

function layoutCss(): string {
  return WIREFRAME_CSS.replace(/:root\s*\{[\s\S]*?\}\n?/, "");
}

function composeRestyleCss(tokensCss: string): string {
  const vars = extractCssVars(tokensCss);
  const mapping: string[] = [];
  for (const { name, alias, fallback } of SHIPYARD_VARS) {
    if (vars[name]) continue;
    mapping.push(vars[alias] ? `  ${name}: var(${alias});` : `  ${name}: ${fallback};`);
  }
  const mapBlock = mapping.length > 0 ? `\n:root {\n${mapping.join("\n")}\n}\n` : "\n";
  return `${tokensCss.trimEnd()}\n${mapBlock}${layoutCss()}`;
}

function replaceStyleBlock(html: string, css: string): string {
  const block = `<style>\n${css.trimEnd()}\n</style>`;
  if (/<style\b[^>]*>[\s\S]*?<\/style>/i.test(html)) {
    return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/i, block);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `  ${block}\n</head>`);
  }
  return `${block}\n${html}`;
}

function styleInner(html: string): string | null {
  const match = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
  return match ? (match[1] ?? "") : null;
}

function keepStyleOnly(before: string, after: string): string {
  const inner = styleInner(after);
  if (inner == null) return before;
  return replaceStyleBlock(before, inner);
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

async function listRelFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const posix = rel ? `${rel}/${entry.name}` : entry.name;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) await walk(child, posix.replaceAll("\\", "/"));
      else if (entry.isFile()) out.push(posix.replaceAll("\\", "/"));
    }
  };
  await walk(dir, "");
  return out;
}

function absFromRel(dir: string, rel: string): string {
  return join(dir, ...rel.split("/"));
}

async function removeRel(dir: string, rel: string): Promise<void> {
  const abs = absFromRel(dir, rel);
  try {
    await unlink(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let parent = dirname(abs);
  while (parent.startsWith(dir) && parent !== dir) {
    try {
      await rmdir(parent);
    } catch {
      break;
    }
    parent = dirname(parent);
  }
}

async function deleteStaleWireframePages(dir: string, pages: ScreenPage[]): Promise<void> {
  const keep = new Set([INDEX_NAME, ...pages.map((page) => `${page.slug}.html`)]);
  for (const rel of await listRelFiles(dir)) {
    if (!rel.toLowerCase().endsWith(".html")) continue;
    if (keep.has(rel)) continue;
    await removeRel(dir, rel);
  }
}

async function loadRestyleCss(projectRoot: string): Promise<string | null> {
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

async function snapshotTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rel of await listRelFiles(dir)) {
    out.set(rel, await readFile(absFromRel(dir, rel), "utf8"));
  }
  return out;
}

async function restoreTree(dir: string, snap: ReadonlyMap<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const rel of await listRelFiles(dir)) {
    if (!snap.has(rel)) await removeRel(dir, rel);
  }
  for (const [rel, body] of snap) {
    const abs = absFromRel(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body, "utf8");
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function restoreOptional(path: string, snap: string | null): Promise<void> {
  if (snap == null) {
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, snap, "utf8");
}

function spawnWireframePrompt(specId: string, restyled: boolean, frozen: boolean): string {
  const palette = restyled
    ? "Brand tokens from the active design-system package win. Keep --bg/--ink/--accent/--muted mapped."
    : "Keep the palette: background #f5f5f0, ink #222, accent #c45c26, muted #888.";
  const task = frozen
    ? "You may only change the <style> block. Do not add, remove, or rewrite screens or inner markup."
    : "Rewrite inner markup of HTML files in the wireframes directory.";
  return [
    `${task} Files: .legion-cli/specs/${specId}/wireframes/.`,
    "Leave INDEX.html as the index of screens.",
    "Do not write SPEC.md, prd.md, or anything outside the wireframes directory.",
    palette,
    "Do not add <script>, <iframe>, <object>, <embed>, on* event attributes, or javascript: URLs.",
    "When done, write a short summary to .legion-cli/cache/runs/<id>/summary.md.",
  ].join("\n");
}

async function restyleExisting(dir: string, css: string): Promise<void> {
  for (const rel of await listRelFiles(dir)) {
    if (!rel.toLowerCase().endsWith(".html")) continue;
    const abs = absFromRel(dir, rel);
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
  for (const rel of await listRelFiles(dir)) {
    if (!rel.toLowerCase().endsWith(".html")) continue;
    validateHtml(await readFile(absFromRel(dir, rel), "utf8"), skipPalette);
  }
}

async function requireExpectedPages(
  dir: string,
  pages: ScreenPage[],
  frozen: boolean,
  snapshot: ReadonlyMap<string, string>,
): Promise<void> {
  const existing = new Set(await listRelFiles(dir));
  const required = frozen
    ? [...snapshot.keys()].filter((rel) => rel.toLowerCase().endsWith(".html"))
    : [INDEX_NAME, ...pages.map((page) => `${page.slug}.html`)];
  const missing = required.filter((name) => !existing.has(name));
  if (missing.length > 0) {
    refuse(`wireframe HTML missing ${missing.join(", ")}`, HINT.wireframe);
  }
}

async function dropNonHtmlExtras(dir: string, snap: ReadonlyMap<string, string>): Promise<void> {
  for (const rel of await listRelFiles(dir)) {
    if (rel.toLowerCase().endsWith(".html")) continue;
    if (!snap.has(rel)) await removeRel(dir, rel);
  }
}

async function applyFrozenCssOnly(dir: string, snap: ReadonlyMap<string, string>): Promise<void> {
  for (const rel of await listRelFiles(dir)) {
    if (!snap.has(rel)) await removeRel(dir, rel);
  }
  for (const [rel, before] of snap) {
    const abs = absFromRel(dir, rel);
    let after: string;
    try {
      after = await readFile(abs, "utf8");
    } catch {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, before, "utf8");
      continue;
    }
    if (!rel.toLowerCase().endsWith(".html")) {
      if (after !== before) await writeFile(abs, before, "utf8");
      continue;
    }
    await writeFile(abs, keepStyleOnly(before, after), "utf8");
  }
}

type WireframePrepareInput = {
  projectRoot: string;
  dir: string;
  specDir: string;
  spec: Spec;
  specBody: string;
  screens: string[];
  opts: WireframeOptions;
  writeSpec: (spec: Spec, body: string) => Promise<void>;
};

type WireframeSession = {
  spec: Spec;
  frozen: boolean;
  restyled: boolean;
  skipPalette: boolean;
  pages: ScreenPage[];
  dir: string;
  snapshot: Map<string, string>;
  specMdPath: string;
  prdPath: string;
  specSnap: string | null;
  prdSnap: string | null;
  spawnPrompt: string;
};

type WireframeSpawnFinish = {
  spawned: boolean;
  revert: RevertResult | null;
  error?: unknown;
};

export async function prepareWireframe(input: WireframePrepareInput): Promise<WireframeSession> {
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
  if (input.opts.restyle && !restyleCss) {
    refuse("wireframe --restyle needs an active design-system package", HINT.designGenerate);
  }
  if (frozen && input.opts.restyle) {
    try {
      await readFile(join(dir, INDEX_NAME));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        refuse("wireframe --restyle needs existing INDEX.html", HINT.wireframeRestyle);
      }
      throw err;
    }
  }
  if (restyleCss) {
    await mkdir(dir, { recursive: true });
    await restyleExisting(dir, restyleCss);
    restyled = true;
  }

  const snapshot = await snapshotTree(dir);
  const specMdPath = join(input.specDir, "SPEC.md");
  const prdPath = join(input.specDir, "prd.md");
  return {
    spec,
    frozen,
    restyled,
    skipPalette: Boolean(input.opts.restyle && restyled),
    pages,
    dir,
    snapshot,
    specMdPath,
    prdPath,
    specSnap: await readOptional(specMdPath),
    prdSnap: await readOptional(prdPath),
    spawnPrompt: spawnWireframePrompt(spec.id, restyled, frozen),
  };
}

async function wireframeResult(session: WireframeSession): Promise<WireframeResult> {
  const existing = new Set(await listRelFiles(session.dir));
  const resultPages = session.frozen
    ? [...existing]
        .filter((rel) => rel.toLowerCase().endsWith(".html") && rel !== INDEX_NAME)
        .sort()
        .map((rel) => wireframeStorePath(session.spec.id, rel))
    : session.pages
        .filter((page) => existing.has(`${page.slug}.html`))
        .map((page) => wireframeStorePath(session.spec.id, `${page.slug}.html`));
  return {
    specId: session.spec.id,
    status: session.spec.status === "draft" ? "draft" : "frozen",
    index: wireframeStorePath(session.spec.id, INDEX_NAME),
    pages: resultPages,
    restyled: session.restyled,
  };
}

export async function finishWireframe(
  session: WireframeSession,
  spawned: WireframeSpawnFinish | null,
): Promise<WireframeResult> {
  const { dir, frozen, pages, snapshot, skipPalette } = session;
  if (spawned?.spawned) {
    await restoreOptional(session.specMdPath, session.specSnap);
    await restoreOptional(session.prdPath, session.prdSnap);
    if (frozen) await applyFrozenCssOnly(dir, snapshot);
    else await dropNonHtmlExtras(dir, snapshot);
    let htmlFailed: unknown;
    try {
      await validateDir(dir, skipPalette);
      await requireExpectedPages(dir, pages, frozen, snapshot);
    } catch (err) {
      htmlFailed = err;
      await restoreTree(dir, snapshot);
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
    if (!frozen) await deleteStaleWireframePages(dir, pages);
  } else {
    await validateDir(dir, skipPalette);
  }
  return wireframeResult(session);
}
