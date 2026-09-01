import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { legionJsonSchemas } from "./json-schema.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(pkgRoot, "json");

mkdirSync(outDir, { recursive: true });

for (const [name, schema] of Object.entries(legionJsonSchemas())) {
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(schema, null, 2)}\n`);
}
