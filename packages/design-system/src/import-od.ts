import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_VERSION, type DesignSystemPackage } from "@9thlevelsoftware/legion-cli-schema";
import { DS_HINT, refuse } from "./errors.js";
import { hashPackageFiles } from "./integrity.js";
import { parseOpenDesignManifest } from "./od.js";
import { assertSafeRelative, designPaths } from "./paths.js";
import { assertInitialized } from "./project.js";
import { resolveLocalDir } from "./source.js";

export type ImportOdResult = {
  id: string;
  dest: string;
  manifest: DesignSystemPackage;
};

/** One-way: od-design-system-project/v1 → legion-cli-design-system/v1. Does not activate. */
export async function importOpenDesign(opts: {
  projectRoot: string;
  source: string;
  cwd?: string;
}): Promise<ImportOdResult> {
  assertInitialized(opts.projectRoot);
  const srcDir = resolveLocalDir(opts.source, opts.cwd ?? process.cwd());
  const manifestPath = join(srcDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    refuse("OpenDesign import requires manifest.json", DS_HINT.importOd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    refuse("OpenDesign manifest.json is not valid JSON", DS_HINT.importOd);
  }
  let od;
  try {
    od = parseOpenDesignManifest(raw);
  } catch {
    refuse("OpenDesign import requires schemaVersion od-design-system-project/v1", DS_HINT.importOd);
  }

  const usageRel = od.usage ? assertSafeRelative(od.usage, "usage") : undefined;
  const required = [od.files.design, od.files.tokens, ...(usageRel ? [usageRel] : [])];
  for (const file of required) {
    if (!existsSync(join(srcDir, file))) {
      refuse(`OpenDesign package is missing ${file}`, DS_HINT.importOd);
    }
  }

  const dest = designPaths(opts.projectRoot).packageDir(od.id);
  await mkdir(dest, { recursive: true });
  for (const file of required) {
    await cp(join(srcDir, file), join(dest, file), { dereference: true, force: true });
  }
  if (od.files.components && existsSync(join(srcDir, od.files.components))) {
    await cp(join(srcDir, od.files.components), join(dest, od.files.components), {
      dereference: true,
      force: true,
    });
  }

  const copied = [...required];
  const sha = await hashPackageFiles(dest, copied);
  const manifest: DesignSystemPackage = {
    schemaVersion: SCHEMA_VERSION.designSystem,
    id: od.id,
    name: od.name,
    description: od.description ?? od.category,
    source: { type: "local", origin: srcDir },
    files: {
      design: "DESIGN.md",
      tokens: "tokens.css",
      ...(usageRel ? { usage: usageRel } : {}),
    },
    integrity: { sha256: sha },
  };
  await writeFile(join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { id: manifest.id, dest, manifest };
}
