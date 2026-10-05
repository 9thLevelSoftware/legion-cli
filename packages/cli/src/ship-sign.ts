import { StringDecoder } from "node:string_decoder";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DeliveryRefusalError, signDeliveryBundle } from "@9thlevelsoftware/legion-cli-persist";
import { refuse } from "@9thlevelsoftware/legion-cli-core";
import type { CliOpts } from "./io.js";
import { writeErr, writeJson, writeOut } from "./io.js";

const SIGN_HINT = "legion-cli ship sign <bundle> --key <external-pkcs8-path>";
const PASSPHRASE_MAX_BYTES = 4096;

async function discoverProjectRoots(projectPath: string): Promise<string[]> {
  const roots: string[] = [];
  let current = resolve(projectPath);
  for (;;) {
    try {
      const stat = await lstat(join(current, ".legion-cli"));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe project control directory");
      roots.push(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

async function readHiddenPassphrase(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") throw new Error("A TTY is required to read an encrypted signing-key passphrase");
  const wasPaused = input.isPaused();
  const wasRaw = input.isRaw;
  process.stderr.write("Signing key passphrase: ");
  try {
    input.setRawMode(true);
    input.resume();
    return await new Promise<string>((resolveLine, reject) => {
      const decoder = new StringDecoder("utf8");
      let value = "";
      let receivedBytes = 0;
      const cleanup = () => {
        input.off("data", onData);
        input.off("error", onError);
        input.off("close", onClose);
      };
      const finish = (error?: Error) => {
        cleanup();
        if (error) reject(error);
        else resolveLine(value);
      };
      function onError(error: Error) {
        finish(error);
      }
      function onClose() {
        finish(new Error("Passphrase input closed"));
      }
      const onData = (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
        receivedBytes += bytes;
        if (receivedBytes > PASSPHRASE_MAX_BYTES) return finish(new Error("Passphrase exceeds the supported input limit"));
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        for (const char of text) {
          if (char === "\u0003") return finish(new Error("Passphrase input cancelled"));
          if (char === "\u0004") return finish();
          if (char === "\r" || char === "\n") return finish();
          if (char === "\u007f" || char === "\b") {
            value = Array.from(value).slice(0, -1).join("");
            continue;
          }
          if (Buffer.byteLength(value + char, "utf8") > PASSPHRASE_MAX_BYTES) {
            return finish(new Error("Passphrase exceeds the supported input limit"));
          }
          value += char;
        }
      };
      input.on("data", onData);
      input.once("close", onClose);
      input.once("error", onError);
    });
  } finally {
    try {
      input.setRawMode(wasRaw);
    } finally {
      if (wasPaused) input.pause();
      else input.resume();
      process.stderr.write("\n");
    }
  }
}

export async function runShipSign(opts: CliOpts, directory: string, flags: { key: string }): Promise<number> {
  const bundlePath = resolve(directory);
  const keyPath = resolve(flags.key);
  let keyIds: string[];
  let passphrase: string | undefined;
  try {
    let envelope;
    try {
      const signingOptions = {
        projectRoot: resolve(opts.project),
        projectRoots: await discoverProjectRoots(opts.project),
      };
      envelope = await signDeliveryBundle(bundlePath, keyPath, signingOptions);
    } catch (error) {
      const encryptedKeyRefusal = error instanceof DeliveryRefusalError &&
        (error as DeliveryRefusalError & { code?: string }).code === "ERR_ENCRYPTED_DELIVERY_KEY";
      if (!encryptedKeyRefusal || !process.stdin.isTTY) throw error;
      passphrase = await readHiddenPassphrase();
      envelope = await signDeliveryBundle(bundlePath, keyPath, {
        projectRoot: resolve(opts.project),
        projectRoots: await discoverProjectRoots(opts.project),
        passphrase,
      });
    }
    keyIds = envelope.signatures.map((signature) => signature.keyid);
  } catch {
    refuse("ship sign refused the bundle or signing key", SIGN_HINT);
  } finally {
    passphrase = undefined;
  }
  if (opts.json) {
    writeJson({ signed: true, signatureCount: keyIds.length, keyIds, bundle: bundlePath });
  } else {
    writeOut("Local delivery signature written.");
    for (const keyId of keyIds) writeOut(`Key ID: ${keyId}`);
  }
  return 0;
}

