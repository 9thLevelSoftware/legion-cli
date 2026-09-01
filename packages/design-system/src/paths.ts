import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LEGION_DIR = ".legion-cli";

export const CRAFT_SLUGS = [
  "typography",
  "color",
  "anti-ai-slop",
  "accessibility-baseline",
  "overflow-and-clipping",
] as const;

export type CraftSlug = (typeof CRAFT_SLUGS)[number];

export type DesignPaths = {
  designDir: string;
  craftDir: string;
  packagesDir: string;
  activeYaml: string;
  designMd: string;
  packageDir: (id: string) => string;
};

export function designPaths(projectRoot: string): DesignPaths {
  const designDir = join(resolve(projectRoot), LEGION_DIR, "design");
  return {
    designDir,
    craftDir: join(designDir, "craft"),
    packagesDir: join(designDir, "packages"),
    activeYaml: join(designDir, "active.yaml"),
    designMd: join(designDir, "DESIGN.md"),
    packageDir: (id: string) => join(designDir, "packages", id),
  };
}

export function toPosix(input: string): string {
  return input.replaceAll("\\", "/");
}

/** Reject path traversal in package ids and declared relative files. */
export function assertSafeRelative(path: string, label: string): string {
  const posix = toPosix(path).replace(/^\.\//, "");
  if (!posix || posix.startsWith("/") || /^[A-Za-z]:/.test(posix) || posix.includes("\\")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const parts = posix.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return posix;
}

export function packageRootFromModule(from = import.meta.url): string {
  return join(dirname(fileURLToPath(from)), "..");
}
