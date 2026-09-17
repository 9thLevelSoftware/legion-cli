import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "..", "src", "trust-roots");
const dest = join(root, "..", "dist", "trust-roots");
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
