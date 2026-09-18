import { createHash } from "node:crypto";
import type { ModuleFingerprint } from "@9thlevelsoftware/legion-cli-schema";

export function sha256utf8(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Comment-only edits must not churn: hash exports+imports, not file bytes. */
export function fingerprintHash(path: string, exports: readonly string[], imports: readonly string[]): string {
  const canonical = `${path}\0${[...exports].sort().join("\n")}\0${[...imports].sort().join("\n")}`;
  return sha256utf8(canonical);
}

export function fingerprintRoot(modules: readonly Pick<ModuleFingerprint, "path" | "hash">[]): string {
  const canonical = modules
    .map((module) => `${module.path}\0${module.hash}`)
    .sort()
    .join("\n");
  return sha256utf8(canonical);
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
