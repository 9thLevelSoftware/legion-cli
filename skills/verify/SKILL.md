# verify

Optional walkthrough notes. Verify is not a ship gate. In-process `verificationCommands` after execute already marked tasks `done`.

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

Do not mark the spec review PASS. That is `legion-cli review`. Do not write packets (v1).

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
