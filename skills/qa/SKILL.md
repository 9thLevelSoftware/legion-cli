---
name: qa
description: >
  Optional extra QA findings under .legion-cli/qa/**. The scorer is in-process;
  this skill is optional findings only. Activated only by `legion-cli qa` when a
  spawnable adapter exists. Do not load other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: qa
    required: false
    allowedRootsRef: SKILL_CONTRACTS.qa
---

# qa

Optional extra findings under `.legion-cli/qa/**`.

The scorer is in-process (`packages/qa/src/score.ts`). This skill is optional findings only. It is not the ship gate. `legion-cli qa` scores the product in-process even when this skill does not spawn.

## Contract

Allowed roots:

- `.legion-cli/qa/**`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.

The engine, not this spawn, writes `STATE.md` and the in-process QA score.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

## Task

You may write extra findings under `.legion-cli/qa/**`. Do not claim to score or pass the product.

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
