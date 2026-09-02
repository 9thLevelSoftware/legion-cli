import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesignSystemPackage } from "@9thlevelsoftware/legion-cli-schema";
import { readActive, tryReadPackageManifest } from "./active.js";
import { readCraftFiles } from "./craft.js";
import { designPaths } from "./paths.js";
import { extractCssVars, mergeCssVars } from "./tokens.js";

export const COMPOSE_ORDER = [
  "usage",
  "design",
  "tokens",
  "components",
  "craft",
  "skill",
] as const;

export type ComposeSection = {
  slug: (typeof COMPOSE_ORDER)[number];
  title: string;
  body: string;
};

export type ComposeResult = {
  text: string;
  sections: ComposeSection[];
  overridden: string[];
  packageId?: string;
};

async function readIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, "utf8");
}

/**
 * USAGE.md → DESIGN.md → tokens.css → component index → craft slugs → skill body.
 * Brand tokens win; craft covers the rest.
 */
export async function composeDesignContext(opts: {
  projectRoot: string;
  skillBody?: string;
}): Promise<ComposeResult> {
  const paths = designPaths(opts.projectRoot);
  const active = await readActive(opts.projectRoot);
  const pkgDir = active?.packageId ? paths.packageDir(active.packageId) : undefined;
  const manifest: DesignSystemPackage | null = pkgDir ? await tryReadPackageManifest(pkgDir) : null;

  const sections: ComposeSection[] = [];
  let overridden: string[] = [];

  if (manifest && pkgDir) {
    const usageName = manifest.files.usage ?? "USAGE.md";
    const usage = await readIfExists(join(pkgDir, usageName));
    if (usage) sections.push({ slug: "usage", title: usageName, body: usage });

    const design = await readIfExists(join(pkgDir, manifest.files.design));
    if (design) sections.push({ slug: "design", title: manifest.files.design, body: design });

    const tokens = (await readIfExists(join(pkgDir, manifest.files.tokens))) ?? "";
    const craftFiles = existsSync(paths.craftDir) ? await readCraftFiles(paths.craftDir) : [];
    const craftColor = craftFiles.find((file) => file.slug === "color")?.body ?? "";
    const merged = mergeCssVars(extractCssVars(craftColor), extractCssVars(tokens));
    overridden = merged.overridden;
    const tokenBody = [
      tokens.trimEnd(),
      "",
      "Brand tokens win over craft on conflict.",
      overridden.length > 0 ? `Overridden craft tokens: ${overridden.join(", ")}.` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
    if (tokenBody.trim()) {
      sections.push({ slug: "tokens", title: manifest.files.tokens, body: `${tokenBody}\n` });
    }

    const componentIndex =
      (await readIfExists(join(pkgDir, "components.html"))) ??
      (await readIfExists(join(pkgDir, "components.manifest.json")));
    if (componentIndex) {
      sections.push({ slug: "components", title: "component index", body: componentIndex });
    }

    if (craftFiles.length > 0) {
      const craftBody = craftFiles
        .map((file) => `### ${file.slug}\n\n${file.body.trim()}`)
        .join("\n\n");
      sections.push({ slug: "craft", title: "craft", body: `${craftBody}\n` });
    }
  } else {
    const handDropped = await readIfExists(paths.designMd);
    if (handDropped) sections.push({ slug: "design", title: "DESIGN.md", body: handDropped });
    if (existsSync(paths.craftDir)) {
      const craftFiles = await readCraftFiles(paths.craftDir);
      if (craftFiles.length > 0) {
        const craftBody = craftFiles
          .map((file) => `### ${file.slug}\n\n${file.body.trim()}`)
          .join("\n\n");
        sections.push({ slug: "craft", title: "craft", body: `${craftBody}\n` });
      }
    }
  }

  if (opts.skillBody?.trim()) {
    sections.push({ slug: "skill", title: "skill", body: opts.skillBody.endsWith("\n") ? opts.skillBody : `${opts.skillBody}\n` });
  }

  const text = sections
    .map((section) => `## ${section.title}\n\n${section.body.trim()}\n`)
    .join("\n");

  return { text, sections, overridden, packageId: manifest?.id };
}
