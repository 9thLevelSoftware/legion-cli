#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
export COREPACK_ENABLE_NETWORK=0
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export PNPM_CONFIG_OFFLINE=true

if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
  cd -- "$ROOT"
  if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    printf '%s\n' 'autoresearch: prerequisite: installed Node.js 22+ is required.' >&2
    exit 1
  fi
  if ! PNPM_VERSION="$(pnpm --version)"; then
    printf '%s\n' 'autoresearch: prerequisite: installed pnpm 9.15.9 is required; downloads are disabled.' >&2
    exit 1
  fi
  if [[ "$PNPM_VERSION" != '9.15.9' ]]; then
    printf '%s\n' 'autoresearch: prerequisite: installed pnpm 9.15.9 is required.' >&2
    exit 1
  fi
  if [[ ! -d "$ROOT/node_modules" ]]; then
    printf '%s\n' 'autoresearch: prerequisite: dependencies must already be installed; this harness never installs them.' >&2
    exit 1
  fi
  if pnpm --filter '@9thlevelsoftware/legion-cli-core...' run build; then
    exec node "$ROOT/scripts/autoresearch-evidence.mjs"
  else
    status=$?
    printf '%s\n' 'autoresearch: offline core dependency build failed.' >&2
    exit "$status"
  fi
elif command -v wslpath >/dev/null 2>&1 && command -v powershell.exe >/dev/null 2>&1; then
  BRIDGE="$(wslpath -w "$ROOT/scripts/autoresearch-evidence.ps1")"
  exec powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$BRIDGE"
else
  printf '%s\n' 'autoresearch: prerequisite: installed Node.js 22+ and pnpm 9.15.9, or WSL with wslpath and native Windows PowerShell/Node/pnpm, are required.' >&2
  exit 1
fi
