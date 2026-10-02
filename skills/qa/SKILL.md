---
name: qa
description: >
  Optional legacy numeric QA findings under .legion-cli/qa/**. The scorer is in-process
  (packages/qa/src/score.ts); this skill adds optional findings only. Activated
  by `legion-cli qa` (in-process; not gated on a spawnable adapter). Do not load
  other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: qa
    required: false
    allowedRootsRef: SKILL_CONTRACTS.qa
---

# qa

Optional extra findings under `.legion-cli/qa/**`. Numeric QA remains available
for reporting and recovery, but the focused ship gate uses approved checks,
independent review, and requirement-level acceptance evidence.

The scorer is in-process (`packages/qa/src/score.ts`); this skill supplies findings,
not scores or approval. Numeric QA is a gate for the legacy profile, not focused
delivery. QA v2 links test title tags `@ac(<id>)` to SPEC priorities and binds run
reports/scores to the SPEC and tested source. Missing/skipped P0 evidence,
unavailable/failed runners, and stale evidence cannot pass that legacy gate.
Untagged successes provide no acceptance coverage. Its host unit runner is trusted
project code, not sandboxed verification.

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
