import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkoutRoot = resolve(packageRoot, "../..");
for (const name of ["skills", "extensions"]) {
  const source = join(checkoutRoot, name);
  try {
    if (!(await stat(source)).isDirectory()) continue;
  } catch (error) {
    if (error.code === "ENOENT") continue; // Packed consumers already carry resources.
    throw error;
  }
  const target = join(packageRoot, name);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, dereference: false });
}
