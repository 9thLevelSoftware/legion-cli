import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SCHEMA_VERSION, type DesignSystemPackage } from "@9thlevelsoftware/legion-cli-schema";
import { writeActive } from "./active.js";
import { DS_HINT, refuse } from "./errors.js";
import { hashPackageFiles } from "./integrity.js";
import { CRAFT_SLUGS, designPaths } from "./paths.js";
import { assertInitialized } from "./project.js";
import { threeLensReview, type ThreeLensReview } from "./review.js";
import { assertNoUrlFetch } from "./source.js";
import { DEFAULT_TOKENS, extractCssVars, extractHexColors, formatCssVars } from "./tokens.js";

export const GENERATE_Q = {
  work: "What kind of work is this, and which platforms? (e.g. product UI on phone and desktop)",
  wcag: "What WCAG level must we meet? (A, AA, or AAA)",
  brand: "Any existing brand file we must follow? (path or `none`)",
} as const;

export type GenerateBrief = {
  name: string;
  workType: string;
  platforms: string;
  wcag: "A" | "AA" | "AAA";
  brand: string;
};

export type GenerateResult = {
  id: string;
  dest: string;
  manifest: DesignSystemPackage;
  review: ThreeLensReview;
};

const WCAG = new Set(["A", "AA", "AAA"]);

export function parseWcag(raw: string): "A" | "AA" | "AAA" {
  const trimmed = raw.trim().toUpperCase();
  const match = /\b(AAA|AA|A)\b/.exec(trimmed);
  const value = match?.[1] ?? trimmed;
  if (!WCAG.has(value)) {
    refuse("WCAG level must be A, AA, or AAA", DS_HINT.generate);
  }
  return value as "A" | "AA" | "AAA";
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "design";
}

export function splitWorkAndPlatforms(answer: string): { workType: string; platforms: string } {
  const text = answer.trim();
  const on = /\bon\b/i.exec(text);
  if (on && on.index !== undefined) {
    const workType = text.slice(0, on.index).trim() || "product UI";
    const platforms = text.slice(on.index + on[0].length).trim() || "phone, desktop";
    return { workType, platforms };
  }
  return { workType: text || "product UI", platforms: text || "phone, desktop" };
}

function tokensFromBrand(brandText: string | undefined): string {
  if (!brandText) return DEFAULT_TOKENS;
  const vars = extractCssVars(brandText);
  if (Object.keys(vars).length > 0) return formatCssVars(vars);
  const hex = extractHexColors(brandText);
  if (hex.length === 0) return DEFAULT_TOKENS;
  const named: Record<string, string> = {
    "--legion-bg": hex[0] ?? "#f5f5f0",
    "--legion-ink": hex[1] ?? "#222",
    "--legion-accent": hex[2] ?? hex[0] ?? "#c45c26",
    "--legion-muted": hex[3] ?? "#888",
  };
  hex.forEach((color, i) => {
    named[`--brand-${i + 1}`] = color;
  });
  return formatCssVars(named);
}

function designMarkdown(brief: GenerateBrief, brandNote: string): string {
  return [
    `# ${brief.name}`,
    "",
    `${brief.workType} on ${brief.platforms}. WCAG ${brief.wcag}.`,
    "",
    brandNote,
    "",
    "Brand tokens win over craft on conflict. Craft covers the rest.",
    "",
  ].join("\n");
}

export async function generateFromBrief(opts: {
  projectRoot: string;
  brief: GenerateBrief;
  cwd?: string;
}): Promise<GenerateResult> {
  assertInitialized(opts.projectRoot);
  const brandRaw = opts.brief.brand.trim() || "none";
  assertNoUrlFetch(brandRaw, "design-system generate");

  let brandText: string | undefined;
  let brandNote = "No existing brand file.";
  if (!/^(none|no|n\/a|-)$/i.test(brandRaw)) {
    const brandPath = resolve(opts.cwd ?? opts.projectRoot, brandRaw);
    if (!existsSync(brandPath)) {
      refuse(`brand file not found: ${brandRaw}`, "path or none");
    }
    brandText = await readFile(brandPath, "utf8");
    brandNote = `Brand file: ${basename(brandPath)}.`;
  }

  const id = slugify(opts.brief.name);
  const dest = designPaths(opts.projectRoot).packageDir(id);
  await mkdir(dest, { recursive: true });

  const tokensCss = tokensFromBrand(brandText);
  const designMd = designMarkdown(opts.brief, brandNote);
  const usageMd = [
    `# ${opts.brief.name} usage`,
    "",
    "Apply DESIGN.md and tokens.css before craft slugs.",
    "Brand tokens win; craft covers the rest.",
    "",
  ].join("\n");

  await writeFile(join(dest, "DESIGN.md"), designMd, "utf8");
  await writeFile(join(dest, "tokens.css"), tokensCss, "utf8");
  await writeFile(join(dest, "USAGE.md"), usageMd, "utf8");

  const review = threeLensReview({
    workType: opts.brief.workType,
    platforms: opts.brief.platforms,
    wcag: opts.brief.wcag,
    brand: brandRaw,
    designMd,
    tokensCss,
    brandFileText: brandText,
  });

  const files = ["DESIGN.md", "tokens.css", "USAGE.md"];
  const sha = await hashPackageFiles(dest, files);
  const manifest: DesignSystemPackage = {
    schemaVersion: SCHEMA_VERSION.designSystem,
    id,
    name: opts.brief.name,
    description: `${opts.brief.workType} (${opts.brief.platforms}, WCAG ${opts.brief.wcag})`,
    source: { type: "local", origin: dest },
    files: { design: "DESIGN.md", tokens: "tokens.css", usage: "USAGE.md" },
    wcag: opts.brief.wcag,
    integrity: { sha256: sha },
  };
  await writeFile(join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await writeActive(opts.projectRoot, {
    schemaVersion: SCHEMA_VERSION.designActive,
    packageId: id,
    craft: [...CRAFT_SLUGS],
    brandViolation: review.brandViolation,
  });

  return { id, dest, manifest, review };
}


