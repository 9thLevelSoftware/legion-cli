---
name: discuss
description: >
  Optional decision helper used by `legion-cli spec` (and retained by the
  advanced `legion-cli discuss` command). Do not load other skill bodies.
license: UNLICENSED
compatibility: "Legion CLI staging; not vendor auto-discovery"
metadata:
  legion:
    skillId: discuss
    required: false
    allowedRootsRef: SKILL_CONTRACTS.discuss
---

# discuss

Optional decision work for `legion-cli spec`. The advanced `legion-cli discuss`
command can resume or inspect the same records.

## Contract

Allowed roots:

- `.legion-cli/discuss/**`
- `.legion-cli/decisions/**`
- `.legion-cli/cache/runs/<id>/**`

Do not write anything else. Do not `git add` or `git commit`.

## Task

Update `.legion-cli/discuss/DISCUSS.md`. Each decision must have `status: proposed`.

Propose at least:

1. Platform (mobile web vs native vs desktop)
2. Out-of-scope restatement from the intent answers
3. Whether product data is stored locally or not

Do not mark decisions accepted or rejected. The human decides in the CLI; a
focused `spec` run presents unresolved consequential choices before approval.

When done, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
