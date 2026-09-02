# discuss

Optional spawn that proposes decisions for the human to accept or reject.

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

Do not mark decisions accepted or rejected. The human answers Y/n in the CLI, two at a time.

When done, write a short summary to `.legion-cli/cache/runs/<id>/summary.md`.
