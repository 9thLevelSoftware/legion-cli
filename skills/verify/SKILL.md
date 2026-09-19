---
name: verify
description: >
  Optional walkthrough notes; not a ship gate.
  Activated only by `legion-cli verify`. Do not load other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: verify
    required: false
    allowedRootsRef: SKILL_CONTRACTS.verify
---

# verify

Optional walkthrough notes. Verify is not a ship gate. In-process `verificationCommands` after execute already marked tasks `done`.

## Contract

Allowed roots:

- `.legion-cli/qa/verify.md`, `.legion-cli/qa/verify/*.md`
- `.legion-cli/cache/runs/<id>/**`
- new task files `.legion-cli/tasks/TSK-*.md` only (validated and admitted by the engine; existing ones are protected)

Do not write anything else. Do not `git add` or `git commit`.

The engine, not this spawn, writes `STATE.md`, task `status`, and `lastReview`.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

## Task

Write optional walkthrough notes to `.legion-cli/qa/verify.md` (or `.legion-cli/qa/verify/<taskId>.md` when walking one task).

If you find fix work, file a child task (`type: fix`, `parentId`) as a NEW file `.legion-cli/tasks/TSK-*.md` or write `.legion-cli/cache/runs/<id>/extra.json`. You may add new task files; you may not edit existing ones (they are protected; a change is restored and quarantined). An invalid new task file is quarantined and verify fails. Do not expand a live task's `filesAllowed`. Extra work is a linked ticket.

Do not mark the spec review PASS. That is `legion-cli review`. Do not write `.legion-cli/packets/**`. Packets are a human verb (`legion-cli packet new`); this spawn files fix tasks or extra.json only.

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
