import { createHash } from "node:crypto";
import { canonicalJson } from "@9thlevelsoftware/legion-cli-persist";
import { normalizePathKey, type ProvenanceLabel } from "@9thlevelsoftware/legion-cli-schema";

const MAX_ORIGINS = 256;
const MAX_ORIGIN_LENGTH = 64;

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalDigest(domain: string, value: unknown): string {
  return sha256(`${domain}\0${canonicalJson(value)}`);
}

function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let accumulator = 0;
  let result = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}

export function namespacedOrigin(namespace: "file" | "remote", descriptor: unknown): string {
  const digest = createHash("sha256").update(`legion-cli-${namespace}-origin/v1\0`).update(canonicalJson(descriptor)).digest();
  const origin = `${namespace}-${base32(digest)}`;
  if (origin.length > MAX_ORIGIN_LENGTH) throw new Error("provenance origin exceeds schema bound");
  return origin;
}

const confidentialityRank: Record<ProvenanceLabel["confidentiality"], number> = { public: 0, workspace: 1, sealed: 2 };

export function joinLabels(labels: readonly ProvenanceLabel[]): ProvenanceLabel {
  const origins = new Set<string>();
  let integrity: ProvenanceLabel["integrity"] = "approved";
  let confidentiality: ProvenanceLabel["confidentiality"] = "public";
  for (const label of labels) {
    if (label.integrity === "untrusted") integrity = "untrusted";
    if (confidentialityRank[label.confidentiality] > confidentialityRank[confidentiality]) confidentiality = label.confidentiality;
    for (const origin of label.origins) {
      origins.add(origin);
      if (origins.size > MAX_ORIGINS) throw new Error("provenance origin join exceeds schema bound");
    }
  }
  return { origins: [...origins].sort(), integrity, confidentiality };
}

export function remoteResponseLabel(request: ProvenanceLabel, control: ProvenanceLabel, remoteOrigin: string): ProvenanceLabel {
  return joinLabels([request, control, { origins: [remoteOrigin], integrity: "untrusted", confidentiality: "sealed" }]);
}

export type ProductBytesLabelInput = {
  policySources: readonly { id: string; path: string; classification: ProvenanceLabel["confidentiality"] }[];
  baselineSources: readonly { path: string; sha256: string | null }[];
  generated: { sha256: string; label: ProvenanceLabel } | undefined;
  path: string;
  /** SHA-256 of the observed bytes, or null when the path is absent. */
  digest: string | null;
};

/**
 * Labels exact product bytes: declared sources carry their policy classification joined with any generated
 * provenance; undeclared paths whose bytes exactly match generated provenance carry that provenance label;
 * other undeclared paths are sealed/untrusted; bytes matching neither the approval baseline nor generated
 * provenance are additionally sealed/untrusted as an unexplained change.
 */
export function labelProductBytes(input: ProductBytesLabelInput): ProvenanceLabel {
  const key = normalizePathKey(input.path);
  const policy = input.policySources.find((source) => normalizePathKey(source.path) === key);
  const generatedMatches = input.generated !== undefined && input.generated.sha256 === input.digest;
  const labels: ProvenanceLabel[] = [];
  if (policy) labels.push({ origins: [namespacedOrigin("file", { sourceId: policy.id, path: input.path })], integrity: "approved", confidentiality: policy.classification });
  else if (!generatedMatches) labels.push({ origins: [namespacedOrigin("file", { sourceId: "unclassified", path: input.path })], integrity: "untrusted", confidentiality: "sealed" });
  if (input.generated) labels.push(input.generated.label);
  const baseline = input.baselineSources.find((source) => normalizePathKey(source.path) === key);
  if (baseline?.sha256 !== input.digest && !generatedMatches) {
    labels.push({ origins: [namespacedOrigin("file", { sourceId: "unexplained-change", path: input.path })], integrity: "untrusted", confidentiality: "sealed" });
  }
  return joinLabels(labels);
}

export function isSealed(label: ProvenanceLabel): boolean {
  return label.confidentiality === "sealed";
}

export function disclosureLabel(label: ProvenanceLabel, releaseOrigins: readonly string[] | undefined): ProvenanceLabel {
  if (!releaseOrigins?.length || label.confidentiality === "public") return label;
  const allowed = new Set(releaseOrigins);
  if (label.origins.some((origin) => !allowed.has(origin))) return label;
  return { ...label, confidentiality: "public" };
}
