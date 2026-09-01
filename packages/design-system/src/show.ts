import { existsSync } from "node:fs";
import { readActive, tryReadPackageManifest } from "./active.js";
import { CRAFT_SLUGS, designPaths } from "./paths.js";
import { assertInitialized } from "./project.js";

export type DesignShow = {
  packageId?: string;
  name?: string;
  source?: { type: string; origin: string };
  files?: { design: string; tokens: string; usage?: string };
  craft: string[];
  brandViolation: boolean;
  craftCopied: boolean;
};

export async function showDesignSystem(projectRoot: string): Promise<DesignShow> {
  assertInitialized(projectRoot);
  const paths = designPaths(projectRoot);
  const active = await readActive(projectRoot);
  const craft = active?.craft?.length ? active.craft : [...CRAFT_SLUGS];
  const craftCopied = existsSync(paths.craftDir);
  if (!active?.packageId) {
    return {
      craft,
      brandViolation: Boolean(active?.brandViolation),
      craftCopied,
    };
  }
  const manifest = await tryReadPackageManifest(paths.packageDir(active.packageId));
  return {
    packageId: active.packageId,
    name: manifest?.name,
    source: manifest?.source,
    files: manifest?.files,
    craft,
    brandViolation: Boolean(active.brandViolation),
    craftCopied,
  };
}
