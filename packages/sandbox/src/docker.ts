import { spawnSync } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { findOnPath } from "./sandbox.js";

/** Container workdir for the jailRoot bind. Host paths must be translated into this namespace. */
export const DOCKER_WORKDIR = "/workspace";

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

function isNodeExecPath(hostPath: string): boolean {
  const base = hostPath.replaceAll("\\", "/").split("/").pop() ?? "";
  return /^node(\.exe)?$/i.test(base);
}

/**
 * Map a host path into the docker jail. A host exec path is never prefixed with
 * `/workspace/` — the image provides `node`, and a drive-letter path is not a jail rel.
 */
export function translateHostPathToDocker(hostPath: string, jailRoot: string): string {
  const rel = relative(jailRoot, hostPath);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel) && !/^[A-Za-z]:/.test(rel)) {
    return `${DOCKER_WORKDIR}/${rel.replaceAll("\\", "/")}`;
  }
  if (isNodeExecPath(hostPath)) return "node";
  return hostPath;
}

export function dockerWorkdir(prefix: readonly string[]): string | undefined {
  const index = prefix.indexOf("-w");
  if (index >= 0 && prefix[index + 1]) return prefix[index + 1];
  return undefined;
}

export function translateWrapperInvoke(
  wrapper: { argvPrefix: readonly string[] },
  invoke: string,
  cwd: string,
): string {
  if (dockerWorkdir(wrapper.argvPrefix) !== DOCKER_WORKDIR) return invoke;
  return translateHostPathToDocker(invoke, cwd);
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
    `${opts.jailRoot}:${DOCKER_WORKDIR}:rw`,
    "-w",
    DOCKER_WORKDIR,
  ];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v !== undefined) prefix.push("-e", `${k}=${v}`);
    }
  }
  prefix.push(image);
  return prefix;
}
