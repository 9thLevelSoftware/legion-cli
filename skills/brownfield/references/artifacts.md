# Artifacts, schemas, and resuming

Everything for a run lives in `<repo>/.legion-cli/runs/<run-id>/` (gitignored). The `paths` block
returned by `legion-cli brownfield init` / `state` / `--resume` is authoritative — use it to fill
prompt placeholders rather than building paths by hand.

```
.legion-cli/
├── runs/
│   ├── patterns.json            cross-run lessons (brownfield patterns)
│   └── <run-id>/
│       ├── resume.json          phase, effort, flags, size, roster, counters (brownfield state)
│       ├── intent.md            you write — phase 2
│       ├── plan.md              you write — phase 3
│       ├── evidence/            brownfield evidence — tests.md, security.md, docs.md (optional)
│       ├── analysis/<spec>.md   specialists write — phase 4 (merge reads only this dir)
│       ├── findings.md          brownfield merge — phase 4
│       ├── assumptions.md       brownfield merge, then you record user answers — phases 4–5
│       ├── design.md            writer — phase 6
│       ├── summary.md           writer — phase 6 (plain-language one-pager)
│       ├── reviews/             design-review.md (+ .prev.md snapshots), pr-N-<slot>.md, pr-N.md
│       ├── dag.json             brownfield pr-plan / dag / worktree — phase 8
│       ├── exec/pr-N-summary.md implementers — phase 8
│       └── verify.md            verify agent — phase 9
└── worktrees/<run-id>/pr-N/     per-PR checkouts (brownfield worktree) — phase 8
```

`legion-cli run promote <id>` copies every `*.md` above (except `.prev.md` snapshots) into
`.legion-cli/wiki/runs/<id>/`, untrusted until `legion-cli wiki trust`.

## Prompt placeholders → JSON fields

| Placeholder | Source |
|---|---|
| `<workspace_root>` | the repo root (`--project`) |
| `<intent_path>` `<plan_path>` `<findings_path>` `<assumptions_path>` | `paths.intent` `paths.plan` `paths.findings` `paths.assumptions` |
| `<analysis_dir>` `<evidence_dir>` `<reviews_dir>` | `paths.analysisDir` `paths.evidenceDir` `paths.reviewsDir` |
| `<design_path>` `<summary_path>` `<review_path>` | `paths.design` `paths.summary` `paths.designReview` |
| `<output_path>` for a specialist | `roster.outputs[<specialist>]` |
| `<max_prs>` `<lines>` `<tier>` | `size.maxPrs` `size.lines` `size.tier` |
| `<map_path>` `<map_fingerprints_path>` | `map.path` `map.fingerprintsPath` (init JSON; `state.meta.map` on resume) |

Paths are repo-relative with forward slashes; agents resolve them against the repo root.

## intent.md

```markdown
# Intent Brief — <project>

- Run: <run-id> · Effort: <N> · Execute: <yes/no> · Captured: <date>

## Goal
What the user wants from this run, in their words where possible.

## What the software is for
Who uses it and the 2–5 journeys that matter most.

## Axioms (must be true)
| ID | Statement | How to check |
|---|---|---|
| FP-1 | A paid order is never lost or double-charged | trace payment → order write; test |
| FP-2 | … | … |

## Platonic ideal
One paragraph: what this system would look like if built correctly for its purpose, ignoring
sunk cost.

## Success criteria
- [ ] Measurable outcome of this audit/improvement run

## Scope
In: … · Out / off-limits: …

## Symptoms reported
What the user has noticed ("totals sometimes off", "slow on big accounts").

## Constraints
Stack, deadlines, can't-change items, risk tolerance (low/medium/high).

## Open questions
| ID | Question | Status (open/answered/assumed) | Answer or working assumption |
```

Write axioms that a specialist could actually check. "The code is clean" is not an axiom; "a
user can only see their own invoices" is. `roster` reads only the **Goal**, **Symptoms**, and
**Constraints** sections (plus the user's original words) for keyword signals, so put the user's
concerns there.

## plan.md

```markdown
# Analysis Plan — <run-id>

## Objective
One paragraph.

## Roster
Pass 1: … · Pass 2: … (from `roster`; note any signal-added specialists and why)

## Focus
### architecture
- …
### code
- …
(2–3 bullets per specialist: which journeys, directories, axioms, and symptoms to prioritize)

## Run risks (effort ≥ 4)
| Risk | Mitigation |
```

## assumptions.md answers

`merge` writes one block per assumption. To record a user decision, edit that block:

```markdown
### A-001: Deleted accounts keep their orders
- Statement: Deleted accounts keep their orders
…
- Status: confirmed            ← was needs-confirmation
- Answer: Yes — orders are financial records and must survive deletion.
```

Re-running `merge` keeps `confirmed`/`rejected` statuses and their answers (matched on the
statement text), so it's safe to re-merge after a specialist updates its output.

## resume.json fields

Written by `init`, read and updated by every subcommand, schema `legion-cli-run/v1`:
`runId, effort, execute, phase, preSpawnRef (the audited commit), baseBranch (null when detached),
startedAt, updatedAt, context, size, roster, designReviewRounds, assumptionRounds, promoted, meta`.

Set with `legion-cli brownfield state <id> key=value …`. Settable: `phase`, `execute`, `context`,
`designReviewRounds`, `assumptionRounds`, `baseBranch`, and free-form `meta.<key>=<json>` (use it
for agent ids, e.g. `meta.writer="a1b2"`). Effort can't change after init.

Phases: `intent → plan → analysis → assumptions → design → review → present → execute → verify → complete`.
`roster` moves `intent → plan`, `merge` sets `assumptions`, and `pr-plan` sets `execute`; you set
the rest.

## Resuming

`/brownfield --resume <run-id>` (optionally with `--execute` to add execution to a finished plan):

1. Run `legion-cli brownfield --resume <id> [--execute] --json`. A missing run refuses; list
   `.legion-cli/runs/` for the ids that exist.
2. Re-read the artifacts that exist (`artifacts` in the JSON says which); the files are the source
   of truth, not your memory.
3. Continue from `state.phase`; the JSON's `next` names the step:
   - `intent`/`plan`/`analysis`: redo that phase; in `analysis`, only relaunch specialists whose
     entry in `analysisOutputs` is `missing` or `empty`.
   - `assumptions`: re-run `merge` and continue phase 5.
   - `design`/`review`: if `design.md` exists, resume the review loop with a fresh reviewer and
     (on revise) a fresh writer — give them the existing files. Otherwise relaunch the writer.
   - `present`/`complete` + `--execute`: phase 8 (`pr-plan`).
   - `execute`: see `references/execute.md` § Cleanup and resume.
   - `verify`: relaunch verify if `verify.md` is missing, then report.
4. Agent ids from an earlier session can't be messaged; relaunch fresh agents with the files as
   context.

Runs created by the older effort-1 placeholder (phases `analysis | execute | complete`, pages like
`architecture.md` and `code.md`) still load; treat their pages as orientation only and start a new
run for a real audit.
