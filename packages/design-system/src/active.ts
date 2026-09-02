import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  DesignActiveSchema,
  DesignSystemPackageSchema,
  SCHEMA_VERSION,
  type DesignActive,
  type DesignSystemPackage,
} from "@9thlevelsoftware/legion-cli-schema";
import { CRAFT_SLUGS, designPaths } from "./paths.js";

export function emptyActive(craft: string[] = [...CRAFT_SLUGS]): DesignActive {
  return {
    schemaVersion: SCHEMA_VERSION.designActive,
    craft,
    brandViolation: false,
  };
}

export async function readActive(projectRoot: string): Promise<DesignActive | null> {
  const path = designPaths(projectRoot).activeYaml;
  if (!existsSync(path)) return null;
  const raw = parseYaml(await readFile(path, "utf8"));
  const parsed = DesignActiveSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function writeActive(projectRoot: string, active: DesignActive): Promise<void> {
  const path = designPaths(projectRoot).activeYaml;
  await mkdir(dirname(path), { recursive: true });
  const yaml = stringifyYaml(active, { lineWidth: 0 });
  await writeFile(path, yaml.endsWith("\n") ? yaml : `${yaml}\n`, "utf8");
}

export async function readPackageManifest(dir: string): Promise<DesignSystemPackage> {
  const raw = JSON.parse(await readFile(joinManifest(dir), "utf8")) as unknown;
  return DesignSystemPackageSchema.parse(raw);
}

export async function tryReadPackageManifest(dir: string): Promise<DesignSystemPackage | null> {
  try {
    return await readPackageManifest(dir);
  } catch {
    return null;
  }
}

function joinManifest(dir: string): string {
  return join(dir, "manifest.json");
}
