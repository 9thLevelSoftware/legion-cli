---
name: interview
description: >
  Optional intent-capture helper used by `legion-cli spec` (and retained by
  the advanced `legion-cli intent` command). Do not load other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: interview
    required: false
    allowedRootsRef: SKILL_CONTRACTS.interview
---

# interview

Optional intent-capture polish. In the focused workflow, `legion-cli spec`
owns this work; `legion-cli intent` remains an advanced recovery surface.

## Contract

Allowed roots:

- `.legion-cli/wiki/product/**`
- `.legion-cli/specs/*/prd.md`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.

## Task

Rewrite `.legion-cli/specs/<specId>/prd.md` from `.legion-cli/wiki/product/intent-answers.yaml`.

Keep the mapped fields: personas, problem, mustBeTrue, mustNotChange, outOfScope, happyPath, screens.

**Do not ask the user any questions.** The interview is finished.

When done, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
