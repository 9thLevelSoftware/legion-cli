# Design document and review loop (phase 6)

## Contents
1. Writer prompt
2. Design document template
3. Reviewer prompt
4. Loop mechanics

## 1. Writer prompt

Launch one `general-purpose` agent, `description: "[writer] brownfield design doc"`. Save its ID —
every revision round goes back to the same agent via SendMessage so it keeps its reasoning.

```
You are a senior systems architect writing an improvement design document for an existing
codebase at <workspace_root>. A team of specialists has already audited it; your job is to turn
their evidence into a plan a team could execute with confidence.

Inputs (read all of them):
- Intent brief: <intent_path>
- Merged findings: <findings_path>  (F-### ids, severity-sorted)
- Assumptions register: <assumptions_path>  (A-### ids; confirmed/rejected ones carry the user's answer)
- Specialist reports, for detail: <analysis_dir>/*.md
- You may read the code to check or sharpen a finding, but don't invent new findings without
  evidence — if you discover something new and important, add it under "Additional findings" with
  file:line evidence.

<if effort >= 3: paste references/doctrine.md under "## Quality bar">

Write <design_path> using the template below, and <summary_path>: one page, plain language, for
someone who can use the app but doesn't read code — what's solid, what's risky, what we'll do
first and why, and roughly how much work it is.

Principles:
- Every PR must trace to an axiom (FP-n) or finding (F-###). Cut cosmetic churn and drive-by
  refactors; mention deliberately-deferred findings in "Not doing (and why)".
- Order PRs bottleneck-first: the fix that most reduces risk or unblocks others comes first.
  Safety nets (tests that pin current critical behavior) come before risky refactors.
- Each PR should be independently reviewable and revertable: one purpose, a bounded file list,
  and a concrete acceptance check. Use at most <max_prs> PRs (the repo is <lines> lines, tier
  <tier>) — merge related fixes rather than exceed it.
- Proportionality: plan the fixes, not a platform. Don't add test harnesses, CI jobs, helper
  scripts, or process tooling unless a specific finding can't be fixed without them. For a small
  codebase the whole plan should fit comfortably on a couple of pages.
- Where an assumption is unconfirmed, design conservatively and say so.
- Secrets: file:line + [REDACTED] only.

Reply with a 3-line summary when done.
```

## 2. Design document template

Give this to the writer verbatim. The `## PR Plan` block format is parsed by
`legion-cli brownfield pr-plan`, so heading and field names must match (`### PR N: Title`,
`- Depends on:`, `- Files:` comma-separated or `none`, `- Traces to:`, `- Risk:`). PR numbers start at 1
and must be unique; dependencies must exist and be acyclic, or `pr-plan` refuses.

````
# Brownfield Improvement Plan — <project>

## Summary
Verdict (2–3 sentences), the top 3 problems, and the plan in one paragraph.

## Current State
What exists and how it fits together (mermaid diagram if helpful). What's genuinely solid —
say so explicitly; it tells the reader what not to touch.

## First-Principles Assessment
- Axioms (FP-n) and whether each holds today: holds / partially / violated — with finding ids.
- The platonic ideal vs today: the biggest structural gaps.
- Limits: what breaks first at 10×/100×.

## Findings
Grouped by severity (critical → nit). One line each: `F-###` — problem — file:line — covered by PR N / deferred.

## Assumptions & Confidence
Table: A-### | statement | confidence | status | how the plan handles it.

## Risks
Risks of the current system and of the plan itself (migration risk, behavior changes users will
notice), each with a mitigation.

## Strategy
Why this order. What's the bottleneck and how the plan relieves it first.

## Key Decisions
### KD-1: <decision>
- Decision: …
- Alternatives considered: …
- Rationale / evidence: … (cite F-### / A-### / FP-n)

## PR Plan
### PR 1: <short imperative title>
- Depends on: none
- Files: path/a.py, path/b.py
- Traces to: FP-2, F-003, F-007
- Risk: low | medium | high
- Description: what changes and why, precise enough to implement without re-auditing.
- Acceptance: how a reviewer verifies it (tests to add/run, behavior to observe).

### PR 2: <title>
- Depends on: PR 1
…

## Not Doing (and why)
Findings or ideas deliberately deferred, with the reason.

## Open Questions
Only questions the user must answer; each with the options and your recommendation.
````

## 3. Reviewer prompt

Launch `general-purpose`, `description: "[reviewer] brownfield design review"`. Save its ID for
re-reviews. At effort ≥ 4, launch a second reviewer in parallel (`[reviewer-security]`) with the
same prompt plus "Review with a security and data-integrity lens first", writing to
`<reviews_dir>/design-review-2.md`. Merge both into `design-review.md` yourself (concatenate,
renumber R-n, drop exact duplicates) before running `review-status`. For per-PR reviews, pass the
merged file explicitly: `legion-cli brownfield review-status <id> reviews/pr-N.md --json`.

```
You are a staff engineer reviewing an improvement plan for an existing codebase at
<workspace_root>. Be the person who catches the flaw before a team spends two weeks on it.

Read: <design_path>, <summary_path>, <intent_path>, <findings_path>, <assumptions_path>.
Spot-check claims against the code where it matters.

<if effort >= 3: paste references/doctrine.md under "## Quality bar">

Check especially:
- Does every critical/major finding have a PR or an explicit, justified deferral?
- Does every PR trace to FP-n / F-###, and is it worth its risk? Flag churn.
- Ordering: bottleneck-first? Safety-net tests before risky refactors? Are dependencies right and
  acyclic? Is any PR too big to review?
- Are acceptance checks concrete enough to verify?
- Are unconfirmed assumptions handled conservatively? Do Key Decisions cite evidence?
- Would the rollout harm current users (data migrations, behavior changes, downtime)?
- Is summary.md accurate and understandable to a non-engineer?
- Is the plan proportionate? Flag machinery (harnesses, CI, scripts) no finding requires, and
  plans that exceed <max_prs> PRs.

Raise an issue only if fixing it changes what gets built, its order, or its risk. Implementation
details the implementer will naturally work out (exact error-message wording, test names) are
not plan defects. Severity: critical/major = the plan is wrong or would cause harm if executed as
written; minor/nit = it would work but could be better.

Write <review_path> in exactly this format (`legion-cli brownfield review-status` parses it; a
`###` block without a `Severity:` line is not counted as an item):

# Design Review — round <N>

### R-1: <short title>
- Severity: critical | major | minor | nit
- Status: open
- Location: <design.md section or PR N>
- Issue: what's wrong
- Suggestion: how to fix it

(One block per issue. Use `Status: needs-user-input` only when the right answer depends on the
user's preferences or business facts, not on engineering judgment. If you find nothing, write the
heading and "No open issues." — don't invent issues to look thorough.)

Reply with the count of issues by severity.
```

**Re-review message** (SendMessage to the same reviewer):
```
The writer revised <design_path> and responded inline in <review_path>. Re-review:
- For each existing item: if the fix is adequate, set Status: resolved. If a `wontfix`
  justification convinces you, leave it as wontfix. If not, set it back to open and explain why.
- Add new R-n items only for critical or major problems (introduced by the revision or missed
  before). This is verification, not a fresh audit — don't raise new minor/nit items.
Keep the same format. Reply with the counts.
```

## 4. Loop mechanics

**Revise message** (SendMessage to the writer):
```
Review round <N> is at <review_path>. Address every item with Status: open:
- Fix it in design.md / summary.md, then set Status: addressed and add a "- Response:" line
  saying what you changed; or
- set Status: wontfix with a "- Response:" justification (only when you're confident the reviewer
  is wrong); or
- set Status: needs-user-input with the question, if it genuinely depends on the user.
<if user decisions exist:> User decisions (final — apply them, don't debate): <decisions>
Reply with what changed.
```

Each round:
1. Before sending the revise message, snapshot the round:
   `legion-cli brownfield review-status <id> --snapshot --json` copies the review file to
   `reviews/design-review.prev.md`, which later runs compare against to spot reopened wontfix items.
2. After the reviewer finishes, run `legion-cli brownfield review-status <id> --json` (it picks up
   the `.prev.md` snapshot automatically).
3. Act on `verdict` (add `--strict` at effort 5): `pass` / `pass-with-minor` → done; leftover
   minor/nit items go into design.md's Open Questions or "Not Doing" as known limitations ·
   `revise` → revise message · `escalate` → AskUserQuestion with
   both positions for stalemates (reviewer's objection, writer's justification) or the
   needs-user-input question; then send the revise message with the user's decisions.
4. Record the round: `legion-cli brownfield state <id> designReviewRounds=<N> --json`.

5. Stop after 3 rounds (5 at effort 5) even if blocking items remain: show the user the dispute and
   let them decide.

Report each round in one line: `Design review round N: X open (C/M/m/n) → revising`.
