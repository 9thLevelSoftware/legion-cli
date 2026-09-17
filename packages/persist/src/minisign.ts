import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyAsync } from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2.js";
import { MinisignError } from "./errors.js";

export const NINTHLEVEL_MINISIGN_PUB_PATH = fileURLToPath(
  new URL("./trust-roots/9thlevelsoftware.minisign.pub", import.meta.url),
);

const PUB_ALG = "Ed";
const SIG_ALG_HASHED = "ED";
const KEY_ID_LEN = 8;
const PUB_KEY_LEN = 32;
const SIG_LEN = 64;
const PUB_DECODED_LEN = 2 + KEY_ID_LEN + PUB_KEY_LEN;
const SIG_DECODED_LEN = 2 + KEY_ID_LEN + SIG_LEN;

export function readNinthlevelMinisignPub(): string {
  return readFileSync(NINTHLEVEL_MINISIGN_PUB_PATH, "utf8");
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function decodeB64(label: string, value: string): Buffer {
  const buf = Buffer.from(value.trim(), "base64");
  if (buf.length === 0) {
    throw new MinisignError(`${label} is invalid`);
  }
  return buf;
}

function parsePublicKey(publicKey: string): { keyId: Buffer; publicKey: Uint8Array } {
  const lines = splitLines(publicKey);
  if (lines.length < 2 || !lines[0]?.startsWith("untrusted comment:")) {
    throw new MinisignError("minisign public key is invalid");
  }
  const decoded = decodeB64("minisign public key", lines[1] ?? "");
  if (decoded.length !== PUB_DECODED_LEN) {
    throw new MinisignError("minisign public key is invalid");
  }
  const alg = decoded.subarray(0, 2).toString("ascii");
  if (alg !== PUB_ALG) {
    throw new MinisignError("minisign public key is invalid");
  }
  return {
    keyId: decoded.subarray(2, 2 + KEY_ID_LEN),
    publicKey: new Uint8Array(decoded.subarray(2 + KEY_ID_LEN)),
  };
}

function parseSignature(signature: string): {
  keyId: Buffer;
  signature: Uint8Array;
  trustedComment: string;
  globalSignature: Uint8Array;
} {
  const lines = splitLines(signature);
  if (lines.length < 4 || !lines[0]?.startsWith("untrusted comment:")) {
    throw new MinisignError("minisign signature is invalid");
  }
  const decoded = decodeB64("minisign signature", lines[1] ?? "");
  if (decoded.length !== SIG_DECODED_LEN) {
    throw new MinisignError("minisign signature is invalid");
  }
  const alg = decoded.subarray(0, 2).toString("ascii");
  if (alg !== SIG_ALG_HASHED) {
    throw new MinisignError("minisign signature must be hashed (ED)");
  }
  const trustedLine = lines[2] ?? "";
  const prefix = "trusted comment: ";
  if (!trustedLine.startsWith(prefix)) {
    throw new MinisignError("minisign signature is invalid");
  }
  const global = decodeB64("minisign global signature", lines[3] ?? "");
  if (global.length !== SIG_LEN) {
    throw new MinisignError("minisign signature is invalid");
  }
  return {
    keyId: decoded.subarray(2, 2 + KEY_ID_LEN),
    signature: new Uint8Array(decoded.subarray(2 + KEY_ID_LEN)),
    trustedComment: trustedLine.slice(prefix.length),
    globalSignature: new Uint8Array(global),
  };
}

export async function verifyMinisign(opts: {
  payload: string | Buffer;
  signature: string;
  publicKey: string;
}): Promise<void> {
  const pub = parsePublicKey(opts.publicKey);
  const sig = parseSignature(opts.signature);
  if (!pub.keyId.equals(sig.keyId)) {
    throw new MinisignError("minisign key id mismatch");
  }
  const payload = typeof opts.payload === "string" ? Buffer.from(opts.payload, "utf8") : opts.payload;
  const prehash = blake2b(new Uint8Array(payload), { dkLen: 64 });
  const ok = await verifyAsync(sig.signature, prehash, pub.publicKey);
  if (!ok) {
    throw new MinisignError("minisign signature verification failed");
  }
  const globalMsg = Buffer.concat([Buffer.from(sig.signature), Buffer.from(sig.trustedComment, "utf8")]);
  const globalOk = await verifyAsync(sig.globalSignature, new Uint8Array(globalMsg), pub.publicKey);
  if (!globalOk) {
    throw new MinisignError("minisign signature verification failed");
  }
}
