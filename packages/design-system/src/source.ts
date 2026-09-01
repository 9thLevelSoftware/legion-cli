import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DS_HINT, refuse } from "./errors.js";

const GITHUB_PREFIX = /^github:/i;
const WINDOWS_DRIVE = /^[a-zA-Z]:(?:[\\/]|$)/;
const UNC_OR_PROTOCOL_RELATIVE = /^(?:\/\/|\\\\)/;
const URL_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|git@)/i;

/** Protocol-relative, UNC, URL schemes, and github: — not a Windows drive path. */
export function isRemoteLooking(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed || WINDOWS_DRIVE.test(trimmed)) return false;
  if (GITHUB_PREFIX.test(trimmed)) return true;
  if (UNC_OR_PROTOCOL_RELATIVE.test(trimmed)) return true;
  if (URL_SCHEME.test(trimmed)) return true;
  return false;
}

export function isGithubInstallSource(source: string): boolean {
  const trimmed = source.trim();
  if (GITHUB_PREFIX.test(trimmed)) return true;
  return isRemoteLooking(trimmed) && /github\.com/i.test(trimmed);
}

export function isRemoteInstallSource(source: string): boolean {
  return isRemoteLooking(source);
}

function refuseRemote(source: string, asUrlFetch: boolean, label?: string): void {
  const trimmed = source.trim();
  if (isGithubInstallSource(trimmed)) {
    if (asUrlFetch) {
      refuse(`${label ?? "design-system"} refuses github: until signed remote`, "path or none");
    }
    refuse("github: design-system install is not available yet", DS_HINT.localOnly);
  }
  if (isRemoteLooking(trimmed)) {
    if (asUrlFetch) {
      refuse(`${label ?? "design-system"} refuses URL fetch until an SSRF suite exists`, "path or none");
    }
    refuse("design-system install is local directory copy only", DS_HINT.localOnly);
  }
}

/** Local dir copy only. Reject github: and URL fetch until the signed-remote PR. */
export function assertLocalInstallSource(source: string): void {
  refuseRemote(source, false);
}

export function resolveLocalDir(source: string, cwd = process.cwd()): string {
  assertLocalInstallSource(source);
  const abs = resolve(cwd, source.trim());
  // resolve() can turn //host/share into a UNC path; never stat that.
  assertLocalInstallSource(abs);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    refuse(`design-system path is not a local directory: ${source}`, DS_HINT.install);
  }
  return abs;
}

export function assertNoUrlFetch(value: string, label: string): void {
  const trimmed = value.trim();
  if (!trimmed || /^(none|no|n\/a|-)$/i.test(trimmed)) return;
  refuseRemote(trimmed, true, label);
}
