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

Write product code for the assigned ready task. Focused `legion-cli execute`
orchestrates approved ready work until complete or blocked, with one worker by
default. Configured `execution.maxWorkers` or `--until-blocked --jobs <count>` (1–4) can
select bounded parallel work in separate jails with disjoint contracts and
serialized integration. This spawn still receives exactly one bounded task.
`--step` stops after one task; an explicit task ID is targeted recovery. Failed
integration/review evidence stays blocked unless the user explicitly runs
`legion-cli execute --retry`, which retries one failed stage. Execute requires
a spawnable adapter.

Level 3 files only as named; do not load other skills.

Execute runs in an OS jail (cwd is `.legion-cli/sandbox/<runId>`). Copy-out returns only FileContract writes; the engine still reverts extras vs FileContract after wait(). Defense in depth: jail during spawn, revert after. `--allow-no-sandbox` is a TTY gate when only the copy jail is available.

## Contract

Allowed paths (SkillContract ∩ FileContract):

- the current task's `filesAllowed` and `expectedArtifacts` (concrete POSIX paths)
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`. `legion-cli ship` is the human commit gate.

The engine, not this spawn, writes `STATE.md`, task `status`, and tickets.

Implicit forbidden still applies: `.git/**`, `.env*`, `.legion-cli/config.yaml`, `.legion-cli/index/**`.

## Task

Read the FileContract and spec in prompt.md.

Write only listed files. Link every acceptance test to its criterion with the canonical title tag `@ac(AC-ID)`; repeat the tag when one test covers multiple criteria. Also copy each linked criterion's `priority` into the title as `@p0` / `@p1` / `@p2`. Untagged passing tests do not supply acceptance coverage. Visual tests also use `@visual`.

If you discover extra work, stop expanding `filesAllowed` and write `.legion-cli/cache/runs/<id>/extra.json`. Extra work is a linked ticket, never an in-place expansion.

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.

## Approved testing method and scope

Consume approved outcome coverage and optional testingMethod inside the task
contract. Test-first exercises new observable behavior, regression-first
reproduces defects, and existing-checks uses meaningful existing boundaries.
Report unsuitable or unavailable test interfaces. Run a planned check when its
evidence is needed; repeat only after implementation changes, concrete failure,
or explicit retry. Outcome/check references do not create duplicate commands or
independent checkpoints. Never rewrite tests to manufacture passing evidence.
All approved tasks, including P1/P2, must complete; external evidence remains
pending until available.
