import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { isAbsolute, relative } from "node:path";
import { SandboxError } from "./errors.js";
import { findOnPath } from "./sandbox.js";

export const DOCKER_WORKDIR = "/workspace";
export const DOCKER_HOST_EXEC_REFUSAL = "docker jail refuses a host exec path that is not the image node";
export const DOCKER_PIDS_LIMIT = 256;
/** Index digest of library/node:22-alpine (hub.docker.com, 2026-09-23). */
export const DOCKER_PINNED_IMAGE =
  "node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402";

const IMAGE_DIGEST = /@sha256:[a-f0-9]{64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_ENV_KEY =
  /(^|_)(TOKEN|ACCESSTOKEN|KEY|APIKEY|SECRET|PASSWORD|PASSWD|PASS|PWD|PAT|AUTH|AUTHTOKEN|CREDENTIALS?|CONNECTION_STRING|WEBHOOK|WEBHOOK_URL)$/i;

export function findRunnableDocker(): string | undefined {
  const bin = findOnPath("docker", true);
  if (!bin) return undefined;
  const probe = spawnSync(bin, ["info", "--format", "{{.OSType}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
    windowsHide: true,
  });
  if (probe.error || probe.status !== 0) return undefined;
  // A Windows-container daemon accepts `docker info` but cannot run the Linux jail image.
  if (String(probe.stdout ?? "").trim().toLowerCase() !== "linux") return undefined;
  return bin;
}

/** Match the host uid so --cap-drop ALL can still write the jail it owns. */
export function dockerRunUser(): string[] {
  if (process.platform === "win32") return [];
  const info = userInfo();
  if (info.uid < 0 || info.gid < 0) return [];
  return ["--user", `${info.uid}:${info.gid}`];
}

function isNodeExecPath(hostPath: string): boolean {
  const base = hostPath.replaceAll("\\", "/").split("/").pop() ?? "";
  return /^node(\.exe)?$/i.test(base);
}

function isPathName(hostPath: string): boolean {
  return !hostPath.includes("/") && !hostPath.includes("\\") && !/^[A-Za-z]:/.test(hostPath);
}

export function translateHostPathToDocker(hostPath: string, jailRoot: string): string {
  const rel = relative(jailRoot, hostPath);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel) && !/^[A-Za-z]:/.test(rel)) {
    return `${DOCKER_WORKDIR}/${rel.replaceAll("\\", "/")}`;
  }
  if (isNodeExecPath(hostPath)) return "node";
  if (isPathName(hostPath)) return hostPath;
  throw new SandboxError(DOCKER_HOST_EXEC_REFUSAL);
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

function pinImage(image: string | undefined): string {
  if (!image) return DOCKER_PINNED_IMAGE;
  if (!IMAGE_DIGEST.test(image)) {
    throw new SandboxError("docker image must be pinned by sha256 digest");
  }
  return image;
}

function dockerEnvArgs(env?: Record<string, string>): string[] {
  if (!env) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY.test(key)) {
      throw new SandboxError("docker env key is not a valid identifier");
    }
    if (SECRET_ENV_KEY.test(key) || /ACCESSTOKEN/i.test(key)) continue;
    if (/[\r\n\0]/.test(value)) {
      throw new SandboxError("docker env value contains a newline");
    }
    args.push("-e", `${key}=${value}`);
  }
  return args;
}

export function dockerArgvPrefix(opts: {
  jailRoot: string;
  image?: string;
  env?: Record<string, string>;
}): string[] {
  const image = pinImage(opts.image);
  return [
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--pids-limit",
    String(DOCKER_PIDS_LIMIT),
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "-v",
    `${opts.jailRoot}:${DOCKER_WORKDIR}:rw`,
    "-w",
    DOCKER_WORKDIR,
    ...dockerRunUser(),
    ...dockerEnvArgs(opts.env),
    image,
  ];
}
