---
name: verify
description: >
  Optional agent walkthrough; not a ship gate. Notes are not retained today.
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

Optional agent walkthrough. Verify is not a ship gate. In-process `verificationCommands` after execute already marked tasks `done`.

## Contract

Allowed roots:

- `.legion-cli/qa/**` is engine-owned and restored after every spawn: nothing written there survives, so do not use it for notes
- `.legion-cli/tasks/**`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.

The engine, not this spawn, writes `STATE.md`, task `status`, and `lastReview`.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

## Task

Walk the slice. Any notes you want to keep go in `.legion-cli/cache/runs/<id>/summary.md`; the engine does not copy verify notes anywhere else yet (known open item), so put actionable findings in fix tasks (below).

If you find fix work, file a child task (`type: fix`, `parentId`) under `.legion-cli/tasks/` or write `.legion-cli/cache/runs/<id>/extra.json`. Do not expand a live task's `filesAllowed`. Extra work is a linked ticket.

Do not mark the spec review PASS. That is `legion-cli review`. Do not write `.legion-cli/packets/**`. Packets are a human verb (`legion-cli packet new`); this spawn files fix tasks or extra.json only.

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
