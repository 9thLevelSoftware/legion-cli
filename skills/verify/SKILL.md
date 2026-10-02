---
name: verify
description: >
  Optional walkthrough notes for focused execution; not a separate ship gate.
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

Optional walkthrough notes. `verify` is an advanced command, not a separate
ship gate. The focused `execute` stage records planned check evidence and
review before ship.

## Contract

Allowed roots:

- `.legion-cli/qa/**`
- `.legion-cli/tasks/**`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.

The engine, not this spawn, writes `STATE.md`, task `status`, and `lastReview`.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

## Task

Write optional walkthrough notes to `.legion-cli/qa/verify.md` (or `.legion-cli/qa/verify/<taskId>.md` when walking one task).

If you find fix work, file a child task (`type: fix`, `parentId`) under `.legion-cli/tasks/` or write `.legion-cli/cache/runs/<id>/extra.json`. Do not expand a live task's `filesAllowed`. Extra work is a linked ticket.

Do not mark the spec review PASS. That is `legion-cli review`. Do not write `.legion-cli/packets/**`. Packets are a human verb (`legion-cli packet new`); this spawn files fix tasks or extra.json only.

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
