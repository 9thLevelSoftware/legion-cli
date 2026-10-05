import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { parseStrictJson, verifyDeliveryBundle, type DeliveryRequirement, type DeliveryVerificationReport } from "@9thlevelsoftware/legion-cli-persist";
import { refuse } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeJson, writeOut } from "./io.js";

const MAX_TRUST_BYTES = 1024 * 1024;
const REQUIREMENTS: Record<DeliveryRequirement, true> = { integrity: true, "local-key": true, "ci-oidc": true };
const VERIFY_HINT = "legion-cli ship verify <bundle>";
type ShipVerifyFlags = {
  require?: string;
  trustPolicy?: string;
  source?: string;
  artifacts?: string;
  expectApproval?: string;
};
async function readTrustFile(path: string): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(resolve(path), "r");
  } catch {
    refuse("ship verify could not read the external trust file", VERIFY_HINT);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_TRUST_BYTES) refuse("ship verify trust file exceeds the regular-file 1 MiB limit", VERIFY_HINT);
    const buffer = Buffer.alloc(MAX_TRUST_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_TRUST_BYTES) refuse("ship verify trust file exceeds 1 MiB", VERIFY_HINT);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    parseStrictJson(text, { maxBytes: MAX_TRUST_BYTES, maxDepth: 32 });
    return text;
  } catch {
    refuse("ship verify external trust file is malformed", VERIFY_HINT);
  } finally {
    await handle.close();
  }
}

export async function runShipVerify(opts: CliOpts, directory: string, flags: ShipVerifyFlags): Promise<number> {
  const requirement = flags.require ?? "integrity";
  if (!Object.hasOwn(REQUIREMENTS, requirement)) {
    refuse("ship verify --require must be integrity, local-key, or ci-oidc", VERIFY_HINT);
  }
  const trustPolicy = flags.trustPolicy === undefined ? undefined : await readTrustFile(flags.trustPolicy);
  let report: DeliveryVerificationReport;
  try {
    report = await verifyDeliveryBundle(resolve(directory), {
      require: requirement,
      ...(trustPolicy === undefined ? {} : { trustPolicy }),
      ...(flags.source === undefined ? {} : { sourceRoot: resolve(flags.source) }),
      ...(flags.artifacts === undefined ? {} : { artifactsRoot: resolve(flags.artifacts) }),
      ...(flags.expectApproval === undefined ? {} : { expectedApproval: flags.expectApproval }),
    });
  } catch {
    refuse("ship verify could not verify the delivery bundle", VERIFY_HINT);
  }
  if (trustPolicy !== undefined && report.authenticity.reason?.startsWith("Invalid external trust policy:")) {
    refuse("ship verify refused an invalid external trust policy", VERIFY_HINT);
  }
  if (opts.json) {
    writeJson(report);
  } else {
    writeOut(`Bundle integrity: ${report.integrity.status}${report.integrity.reason ? ` (${report.integrity.reason})` : ""}`);
    writeOut(`Authenticity: ${report.authenticity.status}${report.authenticity.method ? ` via ${report.authenticity.method}` : ""}`);
    writeOut(`Supplied content: ${report.suppliedContent.status}`);
    writeOut(`Self-reported approval claim: ${report.claims.status}${report.claims.approvalId ? ` (${report.claims.approvalId})` : ""}`);
    if (report.predicate) writeOut(`Public predicate SHA-256: ${report.predicate.sha256} (predicate.json)`);
    if (report.authenticity.trustedRootAgeMs !== undefined) writeOut(`Trust-root age: ${report.authenticity.trustedRootAgeMs} ms`);
    if (report.integrity.reason) writeOut(`Integrity detail: ${report.integrity.reason}`);
    if (report.authenticity.reason) writeOut(`Authenticity detail: ${report.authenticity.reason}`);
  }
  return report.passed ? 0 : 1;
}
