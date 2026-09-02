import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DesignSystemPackageSchema,
  SCHEMA_VERSION,
  type DesignSystemPackage,
} from "@9thlevelsoftware/legion-cli-schema";
import { readActive, writeActive } from "./active.js";
import { DS_HINT, refuse } from "./errors.js";
import { assertIntegrity, hashPackageFiles } from "./integrity.js";
import { OD_SCHEMA_VERSION } from "./od.js";
import { assertSafeRelative, CRAFT_SLUGS, designPaths } from "./paths.js";
import { assertInitialized } from "./project.js";
import { resolveLocalDir } from "./source.js";

export type InstallResult = {
  id: string;
  dest: string;
  manifest: DesignSystemPackage;
};

function declaredFiles(manifest: DesignSystemPackage): string[] {
  const files = ["manifest.json", manifest.files.design, manifest.files.tokens];
  if (manifest.files.usage) files.push(assertSafeRelative(manifest.files.usage, "files.usage"));
  return files;
}

export async function installLocalDir(opts: {
  projectRoot: string;
  source: string;
  cwd?: string;
}): Promise<InstallResult> {
  assertInitialized(opts.projectRoot);
  const srcDir = resolveLocalDir(opts.source, opts.cwd ?? process.cwd());
  const manifestPath = join(srcDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    refuse("design-system install requires a Legion CLI manifest.json", DS_HINT.install);
  }
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as { schemaVersion?: string };
  if (raw.schemaVersion === OD_SCHEMA_VERSION) {
    refuse("raw OpenDesign folders cannot be installed", DS_HINT.importOd);
  }
  const parsed = DesignSystemPackageSchema.safeParse(raw);
  if (!parsed.success) {
    refuse("design-system install requires schemaVersion legion-cli-design-system/v1", DS_HINT.importOd);
  }
  const files = declaredFiles(parsed.data);
  for (const file of files) {
    if (file === "manifest.json") continue;
    if (!existsSync(join(srcDir, file))) {
      refuse(`design-system package is missing ${file}`, DS_HINT.install);
    }
  }

  const remote = parsed.data.source.type === "github";
  await assertIntegrity(srcDir, files.filter((f) => f !== "manifest.json"), parsed.data.integrity?.sha256, {
    required: remote,
  });
  if (remote) {
    refuse("github: design-system install is not available yet", DS_HINT.localOnly);
  }

  const dest = designPaths(opts.projectRoot).packageDir(parsed.data.id);
  await mkdir(dest, { recursive: true });
  const alreadyInPlace = sameDir(srcDir, dest);
  if (!alreadyInPlace) {
    for (const file of files) {
      if (file === "manifest.json") continue;
      await cp(join(srcDir, file), join(dest, file), { dereference: true, force: true });
    }
    for (const extra of ["components.html", "components.manifest.json"]) {
      if (existsSync(join(srcDir, extra))) {
        await cp(join(srcDir, extra), join(dest, extra), { dereference: true, force: true });
      }
    }
  }

  const copied = files.filter((file) => file !== "manifest.json");
  const sha = await hashPackageFiles(dest, copied);
  const manifest: DesignSystemPackage = {
    ...parsed.data,
    schemaVersion: SCHEMA_VERSION.designSystem,
    source: { type: "local", origin: srcDir },
    integrity: parsed.data.integrity ?? { sha256: sha },
  };
  await writeFile(join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const prev = (await readActive(opts.projectRoot)) ?? {
    schemaVersion: SCHEMA_VERSION.designActive,
    craft: [...CRAFT_SLUGS],
    brandViolation: false,
  };
  await writeActive(opts.projectRoot, {
    ...prev,
    packageId: manifest.id,
    craft: prev.craft.length > 0 ? prev.craft : [...CRAFT_SLUGS],
    brandViolation: false,
  });

  return { id: manifest.id, dest, manifest };
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}
