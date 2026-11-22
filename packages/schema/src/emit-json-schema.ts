import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { legionJsonSchemas } from "./json-schema.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(pkgRoot, "json");

mkdirSync(outDir, { recursive: true });

const schemas = legionJsonSchemas();
const emitted = new Set(Object.keys(schemas).map((name) => `${name}.json`));

for (const [name, schema] of Object.entries(schemas)) {
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(schema, null, 2)}\n`);
}

for (const entry of readdirSync(outDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".json") && !emitted.has(entry.name)) {
    rmSync(join(outDir, entry.name));
  }
}
