import {
  DesignSystemError,
  GENERATE_Q,
  generateFromBrief,
  importOpenDesign,
  installLocalDir,
  parseWcag,
  showDesignSystem,
  splitWorkAndPlatforms,
  type GenerateBrief,
} from "@9thlevelsoftware/legion-cli-design-system";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";
import { readLine, slurpStdin } from "./prompt.js";

export type DesignSystemFlags = {
  name?: string;
  workType?: string;
  platforms?: string;
  wcag?: string;
  brand?: string;
};

function printShow(shown: Awaited<ReturnType<typeof showDesignSystem>>): void {
  const lines = [
    `Active package: ${shown.packageId ?? "none"}`,
    shown.name ? `Name: ${shown.name}` : "",
    shown.source ? `Source: ${shown.source.type} (${shown.source.origin})` : "",
    shown.files
      ? `Files: ${shown.files.design}, ${shown.files.tokens}${shown.files.usage ? `, ${shown.files.usage}` : ""}`
      : "",
    `Craft: ${shown.craft.join(", ")}`,
    shown.craftCopied ? "Craft copied on init." : "Craft not copied.",
    shown.brandViolation ? "Brand violation: yes (blocks spec freeze for UI work)" : "Brand violation: no",
    shown.packageId ? "Brand tokens win over craft." : "",
  ].filter((line) => line.length > 0);
  writeOut(lines.join("\n"));
}

export async function runDesignSystemShow(opts: CliOpts): Promise<number> {
  const shown = await showDesignSystem(opts.project);
  if (opts.json) {
    writeJson(shown);
    return 0;
  }
  printShow(shown);
  return 0;
}

export async function runDesignSystemInstall(opts: CliOpts, dir: string): Promise<number> {
  const result = await installLocalDir({ projectRoot: opts.project, source: dir, cwd: process.cwd() });
  if (opts.json) {
    writeJson({ ok: true, id: result.id, dest: result.dest, source: result.manifest.source });
    return 0;
  }
  writeOut(`Installed ${result.id} from local dir.\nBrand tokens win over craft.\nNext: legion-cli design-system show`);
  return 0;
}

export async function runDesignSystemImportOd(opts: CliOpts, dir: string): Promise<number> {
  const result = await importOpenDesign({ projectRoot: opts.project, source: dir, cwd: process.cwd() });
  if (opts.json) {
    writeJson({
      ok: true,
      id: result.id,
      dest: result.dest,
      schemaVersion: result.manifest.schemaVersion,
      next: `legion-cli design-system install ${result.dest}`,
    });
    return 0;
  }
  writeOut(
    [
      `Imported OpenDesign package as ${result.id} (legion-cli-design-system/v1).`,
      "Raw OpenDesign folders cannot be installed.",
      `Next: legion-cli design-system install ${result.dest}`,
    ].join("\n"),
  );
  return 0;
}

async function collectBrief(opts: CliOpts, flags: DesignSystemFlags): Promise<GenerateBrief> {
  const name = flags.name?.trim();
  let workType = flags.workType?.trim();
  let platforms = flags.platforms?.trim();
  let wcagRaw = flags.wcag?.trim();
  let brand = flags.brand?.trim();

  if (!name) {
    throw new DesignSystemError("design-system generate requires a name", "legion-cli design-system generate --name <id>");
  }

  if (!workType || !platforms || !wcagRaw) {
    await slurpStdin();
    if (!opts.json) {
      writeOut("I'll ask two questions at a time. Answer in your own words.");
      writeOut("");
      writeOut(`1. ${GENERATE_Q.work}`);
      writeOut(`2. ${GENERATE_Q.wcag}`);
      writeOut("");
    }
    if (!workType || !platforms) {
      const workAnswer = await readLine("> ");
      const split = splitWorkAndPlatforms(workAnswer);
      workType = workType || split.workType;
      platforms = platforms || split.platforms;
    }
    if (!wcagRaw) {
      wcagRaw = await readLine("> ");
    }
  }

  if (!brand) {
    await slurpStdin();
    if (!opts.json) {
      writeOut(`1. ${GENERATE_Q.brand}`);
      writeOut("");
    }
    brand = await readLine("> ");
  }

  if (!workType || !platforms || !wcagRaw || !brand) {
    throw new DesignSystemError("design-system generate requires work type, platforms, WCAG, and brand path-or-none", "legion-cli design-system generate");
  }

  return {
    name,
    workType,
    platforms,
    wcag: parseWcag(wcagRaw),
    brand,
  };
}

export async function runDesignSystemGenerate(opts: CliOpts, flags: DesignSystemFlags): Promise<number> {
  const brief = await collectBrief(opts, flags);
  const result = await generateFromBrief({ projectRoot: opts.project, brief, cwd: process.cwd() });
  if (opts.json) {
    writeJson({
      ok: true,
      id: result.id,
      dest: result.dest,
      brandViolation: result.review.brandViolation,
      lenses: result.review.lenses,
      next: "legion-cli design-system show",
    });
    return 0;
  }
  writeOut(
    [
      `Generated ${result.id}.`,
      `Three-lens review: ${result.review.lenses.map((lens) => `${lens.id} ${lens.pass ? "PASS" : "FAIL"}`).join(", ")}.`,
      result.review.brandViolation
        ? "Brand violation: yes — blocks spec freeze for UI work."
        : "Brand violation: no.",
      "Brand tokens win over craft.",
      "Next: legion-cli design-system show",
    ].join("\n"),
  );
  return 0;
}
