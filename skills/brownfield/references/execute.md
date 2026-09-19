# Execute and verify (phases 8–9, `--execute` only)

Goal: turn the reviewed PR plan into a stack of local git branches — one per PR, each implemented
in an isolated worktree, each reviewed to the exit bar — then verify the combined result against
the intent. `legion-cli brownfield` owns the git plumbing (branches, worktrees, DAG state);
implementers only touch their own worktree and branch. The main checkout is never switched.

## Contents
1. Preconditions
2. Build the DAG
3. The execution loop
4. Implementer prompt
5. Per-PR review
6. Publishing (push / PRs)
7. Verify
8. Cleanup and resume

## 1. Preconditions

- The run must have `execute: true` (`legion-cli brownfield --resume <id> --execute --json` sets it).
- The design review must have passed (`review-status` verdict `pass` or `pass-with-minor`). Don't
  execute an unreviewed plan.
- Worktrees don't touch the main checkout, so a dirty main checkout doesn't block execution.
  `worktree` still reports `mainCheckoutDirty`; mention it to the user, since uncommitted work there
  won't be in any PR branch.

## 2. Build the DAG

Run `legion-cli brownfield pr-plan <id> --json`. It parses `## PR Plan` in `design.md` into
`dag.json`: each node has `branch` (`brownfield/<run-id>/pr-N-<slug>`), `base`, `mergeIn`, and
`level`. Roots are based on the **commit the audit ran against** (`preSpawnRef`), not on the
current tip of the branch, so later commits on main can't slip unaudited code into the stack. A
dependent is based on its first dependency's branch and merges the others in. It refuses on missing
dependencies, cycles, duplicate PR numbers, or a missing section — if it does, SendMessage the
writer to fix the PR plan, re-run the design review's `review-status`, and try again. It also
refuses once `dag.json` has progress (any node not `pending`, or a recorded `commit`) and lists those
nodes: on resume, continue with `dag` instead. `pr-plan <id> --force` rebuilds the DAG and resets
every node to `pending`; use it only when the user wants the plan re-executed from scratch.

Report: `Executing PR plan: N PRs in L levels, concurrency C, effort E.`

Why branches stack on their dependencies: a dependent PR is built on top of its dependency's
reviewed commits, so the resulting branches form a stack that can be opened as PRs against each
other without any cherry-picking or re-stacking.

## 3. The execution loop

`legion-cli brownfield dag <id> --json` is the source of truth. It returns `ready` (pending nodes
whose dependencies are all completed), `inFlight`, `done`, `counts`, and every node, and it
cascade-skips dependents of any failed node automatically. Update a node with
`legion-cli brownfield dag <id> pr-3 status=implementing agentId=<id> --json`
(settable: `status`, `commit`, `agentId`, `reviewRounds`, `error`). A node's `worktree` is recorded
by `legion-cli brownfield worktree` and always lives at `.legion-cli/worktrees/<run-id>/<node>`; it
can't be set.

```
loop:
  d = dag <id>
  if d.done: break
  for each node in d.ready, while in-flight count < concurrency:
      w = worktree <id> <node>          # creates the branch at node.base and the checkout
      launch implementer (section 4) with cwd = w.worktree
      dag <id> <node> status=implementing agentId=<agent id>
  wait for any implementer or reviewer to finish, then handle it:
      implementer finished  → confirm the branch moved (git -C <worktree> rev-parse HEAD ≠ base);
                              dag <id> <node> status=reviewing commit=<sha>; launch reviewers (section 5)
      implementer failed    → dag <id> <node> status=failed error="…"  (dependents are skipped)
      review verdict pass   → dag <id> <node> status=completed reviewRounds=N
      review verdict revise → fix cycle (section 5)
```

Node statuses: `pending → implementing → reviewing → completed`, or `failed` / `skipped`.

Launch independent PRs in the same message so they run in parallel. `worktree` refuses a dependent
until its dependency's branch exists, and you should only start it after the dependency is
`completed` (reviewed), so it builds on final code.

If an implementer's branch didn't move (no commit), SendMessage it once asking it to commit its
work; if it still hasn't, mark the PR failed.

## 4. Implementer prompt

Agent: `general-purpose`, `description: "[implementer] pr-N: <title>"`. Don't use
`isolation: "worktree"` — the CLI already created the worktree, and a second one would put the
work on the wrong branch.

```
You are implementing one PR of a reviewed improvement plan. Work ONLY inside this git worktree:
  <absolute path of w.worktree>
It is already checked out on branch <branch>. Run every command with that directory as the working
directory (or `git -C <path>`). Never touch the main checkout or other branches.

<if mergeIn:>
First: git merge --no-edit <each mergeIn branch>     (resolve conflicts carefully if any)
<end>

## Your PR
<paste this node's `spec` from dag.json: title, files, traces-to, risk, description, acceptance>

## Context
- Design doc (read the Summary, Key Decisions, and your PR's neighbors): <paths.design>
- Intent brief (what the software must do): <paths.intent>
- Findings your PR addresses are in <paths.findings> — look up the F-### ids in "Traces to".
<if past patterns:>
## Past issue patterns in this repo — avoid repeating them
<patterns>
<end>
<if user gave standing instructions:>
## User instructions (apply to all work)
<instructions>
<end>

## How to work
- Keep it proportionate: the smallest change that meets the acceptance criteria robustly. No new
  frameworks, harnesses, or abstractions the plan doesn't call for.
- Stay in scope: implement this PR's description and acceptance criteria — nothing else. If you
  discover something else that needs fixing, note it in your summary instead of fixing it.
- Match the codebase's existing style, patterns, and test conventions.
- Add or update tests that prove the acceptance criteria. Run the relevant tests plus any fast
  checks (type check, lint, build) and fix what you broke.
- Secrets: never write credential values into code, commits, or files; use the project's existing
  config mechanism.
- Commit on <branch> with a clear message (you may make several commits). Do not push. Do not
  switch branches.

When done, write <paths.execDir>/pr-N-summary.md: files changed, what you did and why, tests added
and their results (exact commands), deviations from the plan, and follow-ups you noticed.
Reply with a 3-line summary and the final commit SHA.
```

## 5. Per-PR review

Reviewer slots come from `roster` (`executeReviewersDefault`), e.g. `["general", "tests",
"security"]`; adjust per PR — add `security` for any PR touching auth, input handling, secrets,
or payments; drop `tests` for a docs-only PR. Launch all of a PR's reviewers in one message.
Agent: `general-purpose`, `description: "[review:<slot>] pr-N"`.

```
You are reviewing PR <N> ("<title>") of a brownfield improvement plan. Review only; don't modify
the code.

- The change: `git -C <repo root> diff <base>...<branch>` (and `git log <base>..<branch>`)
- A checkout of it for running tests: <worktree path>  (run tests there; don't edit files)
- The plan for this PR: <paste the node's spec>
- Implementer's summary: <paths.execDir>/pr-N-summary.md
- Intent brief: <paths.intent>

<slot-specific focus — pick one:>
general: correctness, error handling, edge cases, fit with existing code, does it actually meet
  the acceptance criteria, anything that makes the codebase worse.
tests: do the tests prove the acceptance criteria and fail if the fix is reverted? Edge and error
  paths? Over-mocking? Do they run and pass?
security: input validation, authz, injection, secrets, data exposure introduced or left unfixed by
  this change. Only exploitable-in-practice issues rate above minor.
plan-alignment: does the change do what the PR plan says — no less, no more? Any scope creep?
  Do interfaces match the design doc?

Write <paths.reviewsDir>/pr-N-<slot>.md in exactly this format:

# PR <N> review (<slot>) — round <R>
### R-1: <title>
- Severity: critical | major | minor | nit
- Status: open
- Location: path:line
- Issue: …
- Suggestion: …

If there's nothing to fix, write the heading and "No open issues." Don't invent issues.
Reply with counts by severity.
```

**Merge + decide:** concatenate the slot files into `reviews/pr-N.md` (renumber R-n, prefix
titles with the slot, e.g. `### R-3: [tests] …`), then
`legion-cli brownfield review-status <id> reviews/pr-N.md --json`.

**Fix cycle** (verdict `revise`): `legion-cli brownfield review-status <id> reviews/pr-N.md --snapshot --json`,
then SendMessage the implementer (same agent, same worktree): "Address every `Status: open` item in
<paths.reviewsDir>/pr-N.md: fix and commit, then set Status: addressed with a Response line — or
wontfix with a justification. Reply when done." Then SendMessage only the reviewers that raised
critical/major items to verify those fixes (resolved / reopened; new items only if critical or
major), re-merge, re-run `review-status`. Record `reviewRounds` with `dag`. Same exit bar as the
design review: `pass` or `pass-with-minor` completes the PR (minor items were already fixed once in
the fix pass); use `--strict` at effort 5.

Escalate (verdict `escalate`, or blocking items still open after 3 rounds) to the user with
AskUserQuestion — reviewer's objection vs implementer's position; their call is final. If the user
chooses to drop the PR, mark it `failed` with the reason (dependents get skipped).

Report each PR in one line: `pr-2 ✓ reviewed (2 rounds, 3 issues fixed)` / `pr-4 ✗ failed: …`.

## 6. Publishing (push / PRs)

When `dag` reports `done` with ≥1 completed PR:

1. List the stack: for each completed node in order — branch, base, commits
   (`git log --oneline <base>..<branch>`).
2. Pushing and opening PRs is visible to others, so ask first unless the user passed `--push`:
   options "Push and open draft PRs", "Push branches only", "Keep local".
3. Push in dependency order: `git push -u origin <branch>`. Open PRs with
   `gh pr create --draft --base <base branch> --head <branch> --title "<title>" --body-file <file>` —
   body: the PR's plan block, the implementer summary, and the review outcome. For a root PR whose
   `base` is a commit SHA, use the branch the run started on (`state.baseBranch`) as `--base`, and
   say in the body which commit it was audited against. A dependent's base is its dependency's
   branch, so reviewers see only that PR's diff; after the lower PR merges, GitHub retargets
   automatically. (If the user uses Graphite, `gt track` each branch instead and let them
   `gt submit`.)
4. No `origin`, no `gh`, or the user said keep local → print the exact commands instead.

Merging is the user's decision, never yours.

## 7. Verify (phase 9)

If no PR completed, skip verify and go to the final report (`state <id> phase=complete`);
`state <id> phase=verify` refuses when no DAG node is `completed`. Otherwise set
`state <id> phase=verify` and launch one agent:
`general-purpose`, `isolation: "worktree"`, `description: "[verify] brownfield result"`.

```
Verify that the completed brownfield PRs achieve the original intent.

Setup in your worktree: git checkout -b brownfield/<run-id>/verify <run's preSpawnRef>, then
`git merge --no-edit` each completed branch in this order: <ordered list>. Report any conflict.

Inputs: intent <paths.intent>, design <paths.design>, findings <paths.findings>, implementer
summaries <paths.execDir>/*.md, pre-change test report <paths.analysisDir>/tests.md (if present).
PRs failed/skipped: <list with reasons>.

1. Run the full test suite and any build/type checks; record exact commands and results.
   Compare against the pre-change results in tests.md, if present.
2. For each success criterion and axiom in the intent: met / partially met / not met / not
   verified — with evidence.
3. For each critical/major finding: fixed (how verified) / not fixed / deferred.
4. Regressions or new problems introduced by the combined changes.
5. What's left between the result and the ideal described in the intent/design.

Write <paths.verify> with sections: Test Results · Criteria Traceability (table: criterion →
KD/PRs → evidence → status) · Findings Status · Regressions · Remaining Gaps · Recommended
Follow-ups. Don't modify anything outside your worktree and that file.
```

Surface verify results in the final report. Regressions go at the top.

## 8. Cleanup and resume

- After verify, remove each PR worktree: `legion-cli brownfield worktree <id> <node> --remove --json`
  (add `--force` only for nodes already recorded as completed or failed). The branches stay — they
  are the deliverable.
- Everything in `.legion-cli/runs/<id>/` stays as the audit trail (gitignored).
- Resuming mid-execute: `dag` has every node's status. Nodes left `implementing`/`reviewing` by a
  crash: if the node's branch has commits beyond `base`, set `status=reviewing` and re-run the
  review; otherwise set `status=pending` and continue the loop (re-running `worktree` reuses the
  existing branch and checkout).
