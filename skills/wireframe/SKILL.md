---
name: wireframe
description: >
  Optional rewrite of inner markup for HTML wireframes after templates.
  Activated only by `legion-cli wireframe --spawn`. Do not load other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: wireframe
    required: false
    allowedRootsRef: SKILL_CONTRACTS.wireframe
---

# wireframe

Optional rewrite of inner markup for HTML wireframes. Templates already produced valid files.

## Contract

Allowed roots:

- `.legion-cli/specs/<activeSpecId>/wireframes/**`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not write `SPEC.md`. Do not `git add` or `git commit`.

## Task

You may replace inner markup of wireframe HTML files under `wireframes/`.

**Keep this palette until `--restyle` with an active design-system package:**

- background `#f5f5f0`
- ink `#222`
- accent `#c45c26`
- muted `#888`

Leave `wireframes/INDEX.html` as the index of screens.

Do not add `<script>`, `<iframe>`, `<object>`, `<embed>`, `on*` event attributes, or `javascript:` URLs.

When done, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
