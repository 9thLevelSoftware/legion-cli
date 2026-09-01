# execute

Write product code for one ready task. Execute is required: Legion CLI refuses if no spawnable adapter is configured.

This is after-the-fact policy, not OS isolation. The engine reverts extras vs FileContract after wait(). Do not claim a sandbox.

## Contract

Allowed paths (SkillContract ∩ FileContract):

- the current task's `filesAllowed` and `expectedArtifacts` (concrete POSIX paths)
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`. `legion-cli ship` is the human commit gate.

The engine, not this spawn, writes `STATE.md`, task `status`, and tickets.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

## Task

Read the FileContract and spec in prompt.md.

Write only listed files. Copy each acceptance criterion's `priority` into new test titles as `@p0` / `@p1` / `@p2` (untagged tests count as P1). Visual tests: `@visual`.

If you discover extra work, stop expanding `filesAllowed` and write `.legion-cli/cache/runs/<id>/extra.json`. Extra work is a linked ticket, never an in-place expansion.

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
