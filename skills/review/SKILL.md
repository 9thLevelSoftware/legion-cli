---
name: review
description: >
  Independent review coordinated by focused `execute`; retained as the
  advanced `legion-cli review` recovery command. New task ids or in-place TSK
  rewrites FAIL the review. Do not load other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: review
    required: true
    allowedRootsRef: SKILL_CONTRACTS.review
---

# review

Independent review of a terminal slice (every task `done` or `blocked`). The
focused `execute` stage coordinates it before ship; `legion-cli review` remains
available for recovery. Required: Legion CLI refuses if no spawnable adapter is configured.

PASS is decided by the engine: only if this spawn created zero new task ids **and** left every existing `TSK-*.md` byte-identical. Filing any task (`type: fix` or otherwise) or rewriting an existing task file is FAIL and requires another review after those tasks are done (and existing files are restored). Do not write `.legion-cli/packets/**`. Packets are a human verb (`legion-cli packet new`); this spawn files fix tasks or extra.json only. Put review comments in the notes file (see Task), not in existing task bodies.

PASS also needs evidence: exit code 0 and a non-empty notes file written by this run. A run that exits non-zero or writes no notes is an error with no verdict, not a PASS. A review that files tasks is a FAIL either way.

For focused workflow evidence, include the explicit line `Verdict: PASS` only
when the approved slice meets its contract and no unresolved findings remain.
Otherwise record findings; do not manufacture a passing verdict.

## Contract

Allowed roots:

- `.legion-cli/qa/review.md` only (engine-owned: `qa/**` is restored after every spawn, so the engine writes this file itself from your run-cache notes; scores and checklists are engine-owned)
- `.legion-cli/tasks/**`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.

The engine, not this spawn, writes `STATE.md`, task `status`, and `lastReview`.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

## Task

Read the frozen spec at `.legion-cli/specs/<activeSpecId>/SPEC.md` and the slice tasks.

Write review notes to `.legion-cli/cache/runs/<id>/review.md`, where `<id>` is this run's id (the prompt gives the concrete path). The engine restores anything else an agent writes under `.legion-cli/qa/**`, so it copies non-empty notes to `.legion-cli/qa/review.md` itself. PASS needs exit code 0 and these notes; a run that writes none is an error, not a PASS.

If the slice does not meet the spec, file fix-plan tasks under `.legion-cli/tasks/` (`type: fix`, `parentId`) or `.legion-cli/cache/runs/<id>/extra.json`. Do not expand a live task's `filesAllowed`. Extra work is a linked ticket.

If the slice is acceptable, write notes only. Do not create tasks. Do not rewrite existing `TSK-*.md`.

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
