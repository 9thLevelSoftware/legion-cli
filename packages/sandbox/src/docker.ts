import { spawnSync } from "node:child_process";
import { findOnPath } from "./sandbox.js";

export function findRunnableDocker(): string | undefined {
  const bin = findOnPath("docker", true);
  if (!bin) return undefined;
  const probe = spawnSync(bin, ["info", "--format", "{{.ServerVersion}}"], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
    windowsHide: true,
  });
  if (probe.error || probe.status !== 0) return undefined;
  return bin;
}

export function dockerArgvPrefix(opts: {
  jailRoot: string;
  image?: string;
  env?: Record<string, string>;
}): string[] {
  const image = opts.image || "node:22-alpine";
  const prefix = [
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${opts.jailRoot}:/workspace:rw`,
    "-w",
    "/workspace",
  ];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v !== undefined) prefix.push("-e", `${k}=${v}`);
    }
  }
  prefix.push(image);
  return prefix;
}
