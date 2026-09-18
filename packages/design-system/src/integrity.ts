import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesignSystemPackage } from "@9thlevelsoftware/legion-cli-schema";
import { DS_HINT, refuse } from "./errors.js";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

/** Manifest bytes mixed into the GitHub tree digest; integrity fields are recursive. */
export function canonicalManifestJson(manifest: DesignSystemPackage | Record<string, unknown>): string {
  const { integrity: _integrity, ...rest } = manifest as DesignSystemPackage & { integrity?: unknown };
  return stableStringify(rest);
}

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

const SHA256_PIN = /^sha256:([a-fA-F0-9]{64})$/;

export function parseIntegrityPin(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const match = SHA256_PIN.exec(trimmed);
  if (!match?.[1]) {
    refuse("integrity must be sha256:<64 hex>", DS_HINT.install);
  }
  return match[1].toLowerCase();
}

export async function assertIntegrity(
  dir: string,
  files: string[],
  expected: string | undefined,
  opts: { required: boolean },
): Promise<string | undefined> {
  if (!expected) {
    if (opts.required) {
      refuse("remote design-system install requires integrity.sha256", DS_HINT.install);
    }
    return undefined;
  }
  const actual = await hashPackageFiles(dir, files);
  if (actual !== expected) {
    refuse("design-system integrity.sha256 mismatch", DS_HINT.install);
  }
  return actual;
}
