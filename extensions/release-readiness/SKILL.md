---
name: release-readiness
description: Collect artifact, version, tag, consumer-install, and platform release evidence.
compatibility: "Legion CLI >=0.0.0"
allowed-tools: Read, Write, Bash(node:*), Bash(npm pack:*), Bash(npm install:*), Bash(pnpm pack:*)
metadata:
  legion:
    extensionId: release-readiness
    version: 1.0.0
    resources:
      references: [references/release-checks.md]
    requiredTools: [node, npm]
    checks: [artifact, version-tag, consumer-install, linux, macos, windows]
    permissions:
      read: [package.json, pnpm-lock.yaml, README.md, CHANGELOG.md, dist, build, .github/workflows]
      write: [.legion-cli/extensions/runs/**]
      commands: [node, npm pack, npm install, pnpm pack]
---

# Release readiness evidence

Use `references/release-checks.md`. Inspect the candidate without publishing,
pushing tags, signing, or mutating registries. Pack artifacts into the run evidence
directory when the project supports it, then install them into a disposable local
consumer. Record exact version and tag relationships and platform evidence.

An absent platform run, missing signature, unavailable registry, or skipped
consumer install must be reported as unavailable. It is never implied by a local
build. Write all checks to `evidence.json`; place corrective work in
`recommendations.json`.
