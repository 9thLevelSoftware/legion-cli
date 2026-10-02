---
name: spec
description: >
  Optional polish of SPEC.md and opt-in HTML wireframes after templates.
  Activated only by `legion-cli spec` when a spawnable adapter exists. Do not load other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: spec
    required: false
    allowedRootsRef: SKILL_CONTRACTS.spec
---

# spec

Optional polish of SPEC.md and, only when requested, HTML wireframes. Templates
already produce a valid Spec. The focused `spec` stage includes intent capture
and consequential decisions before the human runs `legion-cli spec approve`.
The engine may separately run its bounded `spec-challenge` skill; do not perform
or resolve that challenge here.

## Contract

Allowed roots:

- `.legion-cli/specs/<activeSpecId>/**`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.
Do not set spec `status` to `frozen` (the human runs `legion-cli spec approve`).

## Task

You may tighten SPEC.md wording from the intent answers.

When wireframe files exist because the approved work needs a UI, you may replace
their inner markup. Do not create wireframes for a non-UI spec. **Keep this
palette until freeze:**

- background `#f5f5f0`
- ink `#222`
- accent `#c45c26`
- muted `#888`

Leave `wireframes/INDEX.html` as the index of screens.

When done, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
