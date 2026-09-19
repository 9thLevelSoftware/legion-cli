---
name: review
description: >
  Spec-level review of a terminal slice; new task ids or in-place TSK rewrites FAIL the review.
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

PASS is decided by the engine: only if this spawn created zero new task ids **and** left every existing `TSK-*.md` byte-identical. Filing any task (`type: fix` or otherwise) or rewriting an existing task file is FAIL and requires another review after those tasks are done (and existing files are restored). Do not write `.legion-cli/packets/**`. Packets are a human verb (`legion-cli packet new`); this spawn files fix tasks or extra.json only. File review comments in `.legion-cli/qa/**`, not in existing task bodies.

## Contract

Allowed roots:

- `.legion-cli/qa/review.md`
- `.legion-cli/cache/runs/<id>/**`
- new task files `.legion-cli/tasks/TSK-*.md` only (validated and admitted by the engine; existing ones are protected)

Do not write anything else. Do not `git add` or `git commit`.

The engine, not this spawn, writes `STATE.md`, task `status`, and `lastReview`.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

## Task

Read the frozen spec at `.legion-cli/specs/<activeSpecId>/SPEC.md` and the slice tasks.

Write review notes to `.legion-cli/qa/review.md`.

If the slice does not meet the spec, file fix-plan tasks as NEW files `.legion-cli/tasks/TSK-*.md` (`type: fix`, `parentId`) or `.legion-cli/cache/runs/<id>/extra.json`. You may add new task files; you may not edit existing ones. The engine validates each new task file (an invalid one is quarantined and the review FAILs) and re-allocates an id that is already taken. Do not expand a live task's `filesAllowed`. Extra work is a linked ticket.

If the slice is acceptable, write notes only. Do not create tasks. Do not rewrite existing `TSK-*.md`, `STATE.md`, `qa/scores/**` or `qa/checklist.json`: they are protected, and a change is restored, quarantined and FAILs the review.

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
