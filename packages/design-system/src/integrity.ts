import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DS_HINT, refuse } from "./errors.js";

export function sha256Hex(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function hashPackageFiles(dir: string, files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function assertIntegrity(
  dir: string,
  files: string[],
  expected: string | undefined,
  opts: { required: boolean },
): Promise<string | undefined> {
  if (!expected) {
    if (opts.required) {
      refuse("remote design-system install requires integrity.sha256", DS_HINT.localOnly);
    }
    return undefined;
  }
  const actual = await hashPackageFiles(dir, files);
  if (actual !== expected) {
    refuse("design-system integrity.sha256 mismatch", DS_HINT.install);
  }
  return actual;
}
