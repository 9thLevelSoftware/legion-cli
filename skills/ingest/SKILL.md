---
name: ingest
description: >
  Distill a source into wiki prose under .legion-cli/wiki/**.
  Optional. Activated only by `legion-cli ingest --distill`. Do not load other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: ingest
    required: false
    allowedRootsRef: SKILL_CONTRACTS.ingest
---

# ingest

Optional distill of a source into wiki prose. Unused until `legion-cli ingest --distill`.
Default ingest stays excerpt copy; this skill is opt-in.

The engine, not this spawn, clamps spawn-written wiki pages to `trust: untrusted` and overwrites `index.md` / `topics.yaml`.

## Contract

Allowed roots:

- `.legion-cli/wiki/**`
- `.legion-cli/audit/**`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.
Do not write product code (`src/**`). The engine reverts extras vs this SkillContract.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

## Task

Read the capped untrusted source in prompt.md (engine cap: 64 KiB; over that this skill is not spawned).

Write compiled wiki prose under `.legion-cli/wiki/`. Keep pages as notes, not raw dumps. Link existing catalog titles when you know them.

Do not set `trust: reviewed`. Do not overwrite engine-owned `index.md` or `topics.yaml` (the engine replaces them after wait()).

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
