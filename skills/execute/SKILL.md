---
name: execute
description: >
  Write product code for one ready Legion CLI task under FileContract.
  Activated only by `legion-cli execute`. Do not load other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: execute
    required: true
    allowedRootsRef: SKILL_CONTRACTS.execute
---

# execute

Write product code for one ready task. Execute is required: Legion CLI refuses if no spawnable adapter is configured.

Level 3 files only as named; do not load other skills.

Execute runs in an OS jail (cwd is `.legion-cli/sandbox/<runId>`). Copy-out returns only FileContract writes; the engine still reverts extras vs FileContract after wait(). Defense in depth: jail during spawn, revert after. `--allow-no-sandbox` is a TTY gate when only the copy jail is available.

## Contract

Allowed paths (SkillContract ∩ FileContract):

- the current task's `filesAllowed` and `expectedArtifacts` (concrete POSIX paths)
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`. `legion-cli ship` is the human commit gate.

The engine, not this spawn, writes `STATE.md`, task `status`, and tickets.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

Protected paths: everything under `.legion-cli/` except `cache/`, `index/`, `sandbox/`, `worktrees/` and `serve.json` (that includes `STATE.md`, `tasks/**`, `qa/**`, `audit/**`, `specs/**`, `wiki/**`), plus the git control files (`.git/config`, `.git/config.worktree`, `.git/commondir`, `.git/hooks/**`, `.git/info/**`, `.git/objects/info/alternates`, a worktree's `.git` file, `.gitmodules`, `.gitattributes`). The engine snapshots them before this spawn and, after it, moves any change to an out-of-project quarantine and restores the original bytes. Touching one is an incident: the task is blocked. A blocked task is not a dead end — the human reopens it with `legion-cli task retry <id>` after inspecting the quarantine — but it always costs a round trip, so do not treat it as a retryable step.

## Task

Read the FileContract and spec in prompt.md.

Write only listed files. Copy each acceptance criterion's `priority` into new test titles as `@p0` / `@p1` / `@p2` (untagged tests count as P1). Visual tests: `@visual`.

If you discover extra work, stop expanding `filesAllowed` and write `.legion-cli/cache/runs/<id>/extra.json`. Extra work is a linked ticket, never an in-place expansion. Write it only when you have extras: the file must be a JSON array of `{title, …}` objects, and one that cannot be read that way blocks the task. Leaving it out means "no extras".

Exit `0` only when the work is done. A non-zero exit blocks the task with your last 20 lines of stderr.

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
