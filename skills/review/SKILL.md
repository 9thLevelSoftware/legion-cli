---
name: review
description: >
  Spec-level review of a terminal slice; new task ids FAIL the review.
  Activated only by `legion-cli review`. Do not load other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: review
    required: true
    allowedRootsRef: SKILL_CONTRACTS.review
---

# review

Spec-level review of a terminal slice (every task `done` or `blocked`). Required: Legion CLI refuses if no spawnable adapter is configured.

PASS is decided by the engine: only if this spawn created zero new task ids. Filing any task (`type: fix` or otherwise) is FAIL and requires another review after those tasks are done. Do not write `.legion-cli/packets/**`. Packets are a human verb (`legion-cli packet new`); this spawn files fix tasks or extra.json only.

## Contract

Allowed roots:

- `.legion-cli/qa/**`
- `.legion-cli/tasks/**`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.

The engine, not this spawn, writes `STATE.md`, task `status`, and `lastReview`.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

## Task

Read the frozen spec at `.legion-cli/specs/<activeSpecId>/SPEC.md` and the slice tasks.

Write review notes to `.legion-cli/qa/review.md`.

If the slice does not meet the spec, file fix-plan tasks under `.legion-cli/tasks/` (`type: fix`, `parentId`) or `.legion-cli/cache/runs/<id>/extra.json`. Do not expand a live task's `filesAllowed`. Extra work is a linked ticket.

If the slice is acceptable, write notes only. Do not create tasks.

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
