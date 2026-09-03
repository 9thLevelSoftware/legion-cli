---
name: spec
description: >
  Optional polish of SPEC.md and HTML wireframes after templates.
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

Optional polish of SPEC.md and HTML wireframes. Templates already produced a valid Spec.

## Contract

Allowed roots:

- `.legion-cli/specs/<activeSpecId>/**`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.
Do not set spec `status` to `frozen` (the human runs `legion-cli spec approve`).

## Task

You may tighten SPEC.md wording from the intent answers.

You may replace inner markup of wireframe HTML files. **Keep this palette until freeze:**

- background `#f5f5f0`
- ink `#222`
- accent `#c45c26`
- muted `#888`

Leave `wireframes/INDEX.html` as the index of screens.

When done, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
