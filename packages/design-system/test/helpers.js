import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

export const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const odFixture = join(pkgRoot, "test", "fixtures", "od-acme");
export const repoRoot = join(pkgRoot, "..", "..");
export const legionFixture = join(repoRoot, "design-systems", "_fixture-neutral");

export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "legion-ds-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function initStub(dir) {
  const root = join(dir, ".legion-cli");
  await mkdir(join(root, "design", "craft"), { recursive: true });
  await writeFile(join(root, "STATE.md"), "---\nschemaVersion: legion-cli-state/v1\nphase: initialized\n---\n", "utf8");
  return dir;
}
