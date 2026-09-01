import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DS_HINT, refuse } from "./errors.js";

const GITHUB_PREFIX = /^github:/i;
const REMOTE = /^(https?:|git@|ssh:)/i;

export function isGithubInstallSource(source: string): boolean {
  const trimmed = source.trim();
  if (GITHUB_PREFIX.test(trimmed)) return true;
  if (/github\.com/i.test(trimmed) && REMOTE.test(trimmed)) return true;
  return false;
}

export function isRemoteInstallSource(source: string): boolean {
  const trimmed = source.trim();
  if (isGithubInstallSource(trimmed)) return true;
  if (REMOTE.test(trimmed)) return true;
  return false;
}

/** Local dir copy only. Reject github: and URL fetch until the signed-remote PR. */
export function assertLocalInstallSource(source: string): void {
  const trimmed = source.trim();
  if (isGithubInstallSource(trimmed)) {
    refuse("github: design-system install is not available yet", DS_HINT.localOnly);
  }
  if (isRemoteInstallSource(trimmed)) {
    refuse("design-system install is local directory copy only", DS_HINT.localOnly);
  }
}

export function resolveLocalDir(source: string, cwd = process.cwd()): string {
  assertLocalInstallSource(source);
  const abs = resolve(cwd, source.trim());
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    refuse(`design-system path is not a local directory: ${source}`, DS_HINT.install);
  }
  return abs;
}

export function assertNoUrlFetch(value: string, label: string): void {
  const trimmed = value.trim();
  if (!trimmed || /^(none|no|n\/a|-)$/i.test(trimmed)) return;
  if (isRemoteInstallSource(trimmed) || /^file:/i.test(trimmed)) {
    refuse(`${label} refuses URL fetch until an SSRF suite exists`, "path or none");
  }
}
