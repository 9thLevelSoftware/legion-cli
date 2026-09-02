# plan

Emit a task board with file contracts. Plan is required: Legion CLI refuses if no spawnable adapter is configured.

## Contract

Allowed roots:

- `.legion-cli/plans/**`
- `.legion-cli/tasks/**`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.
Do not write product code (`src/**`). The engine reverts extras vs this SkillContract and FAILs the plan.

The engine, not this spawn, writes `STATE.md`, task `status` promotions, and `lastReadiness`.

## Task

Read the frozen spec at `.legion-cli/specs/<activeSpecId>/SPEC.md`.

Write:

- `.legion-cli/plans/<activeSpecId>.md` — short board overview
- `.legion-cli/tasks/TSK-NNNN.md` — one file per task, YAML frontmatter `schemaVersion: legion-cli-task/v1`

Every task MUST have:

- at least one `verificationCommands` entry (empty verification is a plan FAIL)
- non-empty `filesAllowed` of concrete POSIX repo-relative paths (no `*`, `**`, `?`, no `.git/**`)
- exclusive `filesAllowed` (two tasks sharing a path is a plan FAIL)
- `filesForbidden` including `.git/**`, `.legion-cli/config.yaml`, `.legion-cli/index/**`, `.env`, `.env.*`
- `status: ready` if unblocked, else `todo` with `blockedBy`
- `type: feature|fix|bug`, `priority: P0|P1|P2`, `specId` matching the active spec

Optional frontmatter `adapter:` is an AdapterId (`claude|generic|fake|grok|openai|codex|mimo|minimax`). Set it only when SPEC or DISCUSS names that coding CLI; otherwise omit. Never emit `adapter: fake` outside tests.

Emit at least one P0 task.

## Extra work

Do not expand a live task's `filesAllowed`. If you discover extra work, stop expanding and write `.legion-cli/cache/runs/<id>/extra.json`:

```json
{ "title": "short title", "parentId": "TSK-0001", "filesAllowed": ["src/extra.ts"], "verificationCommands": ["pnpm test"], "adapter": "grok" }
```

`extra.json` may include `"adapter": "grok"` (valid AdapterIds only; the engine drops unknown ids and then inherits the parent task adapter if present).

The engine files a linked ticket. Humans use `legion-cli ticket create --parent TSK-x`. Do not amend `filesAllowed` (that is `legion-cli task amend`).

When finished, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
