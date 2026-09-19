---
name: brownfield
description: >-
  First-principles audit and improvement plan for an EXISTING codebase ("brownfield" project) —
  especially one the user can run and demo but can't confidently judge. Orchestrates parallel
  specialist subagents (architecture, product-intent, code, tests, security, performance, docs)
  that treat existing code as evidence rather than ground truth, keeps an assumptions register and
  escalates the risky ones, writes a consolidated improvement design doc with a dependency-ordered
  PR plan sized to the repo, runs a writer↔reviewer loop until no critical/major issues remain, and
  optionally (--execute) implements the plan as worktree-isolated, reviewed git branches. All
  bookkeeping goes through `legion-cli brownfield <sub> --json`. Use this skill whenever the user
  says /brownfield, asks to audit / health-check / assess / sanity-check / "second opinion" an
  existing repo or legacy app, asks "is this built correctly?", "what's wrong with this codebase?",
  "a contractor/AI built this and I'm not sure it's right", wants a prioritized improvement or
  remediation plan for code that already exists, or is inheriting a project and wants to know where
  the bodies are buried — even if they never use the word "brownfield". Not for greenfield design
  of new systems or for reviewing a single small diff/PR.
argument-hint: "<project path and/or description> [--effort 1-5] [--execute] [--lsp] [--push] [--concurrency N] [--resume <run-id>]"
compatibility: "Claude Code skill; drives legion-cli brownfield. Not an engine spawn skill (not in SkillIdSchema)."
---

# Brownfield

You are the **orchestrator** of an audit-and-improve run on an existing codebase. The user can
usually operate the software but can't tell whether its architecture, implementation, tests, or
security are actually sound. Your job is to get them a trustworthy answer and a concrete,
reviewed plan to fix what matters — and, if asked, to carry the plan out.

**Core principle — code is evidence, not ground truth.** Something existing doesn't make it
intentional or correct. Every specialist reconstructs what the system *should* be from the user's
intent and first principles, then diffs reality against that. Inferences get written down as
assumptions with a confidence level; the risky ones go to the user before any plan depends on them.

**Division of labour.** You (and the agents you launch) do all judgment. `legion-cli brownfield`
does the deterministic bookkeeping — run setup, roster, merging, review verdicts, PR-plan parsing,
DAG state, per-PR worktrees — and prints JSON. Never hand-edit `resume.json` or `dag.json`; use
`state` and `dag`.

## How this skill is organized

| File | Read it when |
|---|---|
| `references/specialists.md` | Before launching analysis specialists (phase 4) — prompt templates + output format |
| `references/doctrine.md` | Effort ≥ 3: its text gets pasted into specialist, writer, and reviewer prompts |
| `references/design-and-review.md` | Before phase 6 — writer prompt, design-doc template, reviewer prompt, loop rules |
| `references/execute.md` | Only with `--execute` (phases 8–9) — worktree implementers, per-PR review, stack, verify |
| `references/artifacts.md` | When writing `intent.md`/`plan.md`, or resuming a run — layout and state fields |

### Command map
Always pass `--json` (and `--project <repo>` when the repo isn't the cwd). Every command refuses
with `{"error", "next"}` and exit 1 when a precondition fails — read `next`, don't work around it.

| Phase | Command |
|---|---|
| 1 setup | `legion-cli brownfield init "<user's words>" --effort N [--execute] [--lsp] --json` (also refreshes the codebase map) |
| 1 setup | `legion-cli brownfield patterns --json` (past lessons) |
| 3 plan | `legion-cli brownfield roster <id> --json` |
| 4 analysis | `legion-cli brownfield evidence <id> --json` (optional pre-collected evidence) |
| 4 analysis | `legion-cli brownfield merge <id> --json` |
| 5–6 | `legion-cli brownfield state <id> phase=design --json` · `… designReviewRounds=N` |
| 6 review | `legion-cli brownfield review-status <id> [file] [--strict] [--snapshot] --json` |
| 8 execute | `legion-cli brownfield pr-plan <id> --json` (refuses once the DAG has progress; `--force` resets it) → `dag <id> [node key=value…]` → `worktree <id> <node> [--remove]` |
| any | `legion-cli brownfield state <id> --json` (state, artifacts present, `next`) |
| 10 report | `legion-cli brownfield patterns --add "<lesson>" … --json` · `legion-cli run promote <id> --json` |

## Why you orchestrate instead of doing the audit yourself

Specialists run in fresh contexts with one job each, so they go deep without your context filling
up with file dumps, and their findings are independent rather than all colored by your first
impression. So: you plan, delegate, merge, enforce the quality gates, and talk to the user. You may
do light **orientation** (directory tree, README, manifests, recent `git log`) so you can write
sharp delegation prompts, but you don't author findings, severity calls, or the design doc
yourself. If you notice yourself listing bugs from your own reading, stop and hand that to a
specialist instead. You never modify project source files except in `--execute` mode, and then
only through implementers working inside their own worktrees.

**Launch discipline:** when a step says to launch agents, make the Agent tool calls in that same
message — never announce a launch you haven't made, and never describe results you haven't
received. Independent agents in the same step go in a single message so they run in parallel.
Wait for all of a step's agents to finish before merging their outputs.

## Arguments

| Flag | Default | Meaning |
|---|---|---|
| `<path/description>` | cwd | Repo path and/or natural-language focus ("worried about checkout") |
| `--effort 1-5` | 2 | Breadth and rigor (table below) |
| `--lsp` | off | Require a language server for the codebase map init builds (default: auto, fallback parser) |
| `--execute` | off | After the plan passes review, implement it as local branches (phase 8) |
| `--push` | off | With `--execute`: push branches and open draft PRs via `gh` without asking first |
| `--concurrency N` | 3 | Max parallel PR implementers during `--execute` |
| `--resume <run-id>` | — | Continue an interrupted run (`legion-cli brownfield --resume <id> --json`) |

Flags can appear anywhere; everything else is the project context. Users also invoke this in plain
English ("can you audit ./shop-api, go deep on security") — map that to flags sensibly
(e.g. "go deep"/"thorough" → effort 4; "quick look" → effort 1).

### Effort model

| Effort | Analysis roster | Doctrine injected | Design reviewers | Per-PR reviewers (`--execute`) |
|---|---|---|---|---|
| 1 | architecture → code | no | 1 | 1 |
| 2 | + product-intent (pass 1), tests (pass 2) | no | 1 | 2 |
| 3 | + documentation | yes | 1 | 3 |
| 4 | + security | yes | 2 (general + security-minded) | 4 |
| 5 | + performance, second independent code reviewer | yes | 2 | 5 (incl. plan alignment) |

Keyword signals in the user's context and in the intent brief's Goal / Symptoms / Constraints
sections (auth, payments, slow, flaky tests, README…) add the matching specialist at any effort —
`roster` computes this deterministically. Announce the roster once:
`Brownfield run <id>, effort N: pass 1 [..] → pass 2 [..]; execute: yes/no`.

## Workflow

Track these phases with your todo/task tool if one is available, so progress survives long runs:
`setup · intent · plan · analysis · assumptions · design · review · present · execute · verify · report`.
`state` records the phase; `roster`, `merge`, and `pr-plan` advance it automatically; set the
others yourself with `legion-cli brownfield state <id> phase=<phase>`. `phase=execute` and
`phase=verify` refuse until `reviews/design-review.md` exists, and `phase=verify` also refuses
while no PR is `completed` (skip verify then).

### 1. Setup
- `--resume`: run `legion-cli brownfield --resume <id> --json` (add `--execute` to switch on
  execution for a finished plan). Read `references/artifacts.md` § Resuming and continue from
  `state.phase`; the JSON's `next` says exactly where.
- Otherwise run `legion-cli brownfield init "<user's words>" --effort N [--execute] [--lsp] --json`.
  It refreshes the codebase map (`.legion-cli/map/ARCHITECTURE.md` and `fingerprints.json`, the
  same output as `legion-cli map`), creates `.legion-cli/runs/<id>/` (gitignored), measures the
  repo, and returns `map`, `paths` (every artifact location — use these, never hardcode paths),
  `size` (lines, tier, `maxPrs`, `suggestedEffortMax`), `warnings`, and `next`. With `--lsp` it
  refuses if no language server is on PATH; tell the user, and rerun without `--lsp` if they agree.
- If it refuses with "until init", the repo isn't a Legion project. Tell the user to run
  `legion-cli init --mode brownfield --adapter <id>` first (any configured adapter; the audit itself
  never spawns it) and stop. If it refuses for "git repository", the repo needs `git init` and a
  commit. Don't invent a workaround.
- If `warnings` says the effort exceeds the suggested maximum, say so in the setup announcement.
  Honor an explicit request; when effort came from your own reading of vague words like
  "thorough", use the suggested maximum instead (you can't change a run's effort later — start a
  new run).
- Run `legion-cli brownfield patterns --json` — recurring issue patterns from earlier runs. If any
  exist, pass the top ones to code/tests/security specialists and implementers under
  `## Past issue patterns`; if none, omit that section entirely.

### 2. Intent
You need to know what the software is *for* before anyone can judge it. Orient (tree, README,
manifests, `git log --oneline -20`), then write `paths.intent` per `references/artifacts.md`:
the user's goal, 3–7 **axioms** (FP-1…: testable statements that must be true — "a paid order is
never lost", "user A can never read user B's data"), a one-paragraph platonic ideal, success
criteria, scope, symptoms, constraints, and open questions.

If the essentials are missing — what "working correctly" means, what's broken or worrying,
what's off-limits — ask with AskUserQuestion (one batch, ≤4 questions, concrete options). If you
can't ask (non-interactive run) or the user defers, make reasonable assumptions, mark them in the
brief's open questions, and continue; a thin brief that moves beats a stalled run.

### 3. Plan the analysis
Run `legion-cli brownfield roster <id> --json` → `pass1`, `pass2`, `addedBySignal`,
`injectDoctrine`, `designReviewers`, `executeReviewersDefault`, and `outputs` (each specialist's
output path). Write a short `paths.plan`: the objective, the roster, and 2–3 **focus bullets per
specialist** drawn from the intent (which journeys, modules, and axioms matter most for them). At
effort ≥ 4 also list the top risks to the run itself (huge repo, generated code, no tests,
monorepo…) and how you'll handle them. Focus bullets are the highest-leverage thing you write —
they're what turn a generic audit into one about *this* user's concerns.

### 4. Analysis (two passes)
Read `references/specialists.md` now.
- Optionally run `legion-cli brownfield evidence <id> --json` first. It writes
  `evidence/tests.md` (runners, test files, sources with no nearby test), `evidence/security.md`
  (secret-pattern hits, redacted; lockfile audit), and `evidence/docs.md` (README, wiki orphans,
  exports without nearby docs, from the map init built). Pass those paths to the tests,
  security, code, and documentation specialists as *pre-collected evidence to verify, not
  conclusions*. Use `--skip-audit` offline.
- Set `legion-cli brownfield state <id> phase=analysis`.
- **Pass 1** (architecture, product-intent): launch in parallel. They establish the structural map
  and intent-vs-reality picture that pass 2 builds on.
- **Checkpoint:** skim their Executive Summaries so you can tell pass 2 what to look at.
- **Pass 2** (code, tests, security, …): launch in parallel; each reads pass-1 outputs first.
- Architecture and code are required — if one fails, relaunch once, then stop and report. An
  optional specialist that fails is noted and skipped. `state <id>` shows each specialist's output
  as `present`, `empty`, or `missing`.
- Run `legion-cli brownfield merge <id> --json` → `findings.md` (deduped, F-### ids,
  severity-sorted) and `assumptions.md` (A-### ids, blocking flags). If `emptySources` names a
  specialist, its output didn't follow the format — open it, and relaunch that specialist if it's
  unusable. `ignoredBlocks` lists `###` blocks that lacked a `Severity:` (findings) or
  confidence/impact/status (assumptions).

Report: `Analysis complete: N findings (C critical, M major…), K assumptions, B blocking.`

### 5. Resolve blocking assumptions
Blocking = needs user confirmation, or low confidence where being wrong would be critical/major.
Ask about them with AskUserQuestion — plain language, the evidence, 2–4 concrete options. Record
answers in `assumptions.md`: set `- Status: confirmed` or `- Status: rejected` and add
`- Answer: …` under that assumption. Re-running `merge` keeps recorded answers. If an answer
invalidates a specialist's reasoning, SendMessage that specialist (it keeps its context) with the
decision, then re-run `merge`. Bump `assumptionRounds` via `state`. After 3 rounds with blockers
still open, propose narrowing scope rather than looping. Non-interactive: leave them as explicit
risks for the design doc to handle conservatively. Then `state <id> phase=design`.

### 6. Design document + review loop
Read `references/design-and-review.md`. Launch the **writer** to produce `paths.design` (full plan)
and `paths.summary` (one plain-language page). Then `state <id> phase=review` and loop:
**reviewer** writes `paths.designReview` → `legion-cli brownfield review-status <id> --json` →
- `pass` / `pass-with-minor` → phase 7 (any leftover minor/nit items are listed as known limitations)
- `revise` → `review-status <id> --snapshot` (keeps the round for stalemate detection) → SendMessage
  the writer to address every open item → SendMessage the reviewer to re-review
- `escalate` (needs-user-input, or a wontfix the reviewer reopened) → ask the user; their answer is
  final; the writer applies it

**The exit bar:** zero open **critical and major** issues. Minor and nit items get fixed in the
same revision pass as everything else, but they don't hold the loop open on their own. Re-reviews
verify the fixes; they aren't a fresh audit, so new items are only raised when they're critical or
major. At most 3 rounds, then show the user what's still disputed and let them decide. At effort 5,
pass `--strict` so every severity must reach zero (and allow up to 5 rounds).

Why not "zero of everything" by default: in testing, that rule made the reviewer and writer spiral —
each round of nit-fixing added machinery (CI harnesses, helper scripts) that the next round then
found flaws in, until an 80-line tool had a plan for tooling nobody asked for. Critical/major
issues are what make a plan wrong; polishing the rest is cheaper during implementation.

### 7. Present
`state <id> phase=present`. Show the user: the summary's headline, the top findings
(critical/major with file:line), Key Decisions, remaining risks, and the PR plan as a short
numbered list with dependencies. Resolve any open questions with AskUserQuestion (writer applies
answers; no re-review needed for direct user decisions). Without `--execute`, finish at phase 10 and
mention that `/brownfield --resume <id> --execute` will implement the plan.

### 8–9. Execute and verify (`--execute` only)
Read `references/execute.md` and follow it: `pr-plan` turns the PR plan into a DAG, `worktree`
gives each PR an isolated checkout on its own stacked branch, implementers work only there,
effort-scaled reviewers review each PR until the exit bar is met, then a verify agent checks the
combined result against the intent's success criteria. Pushing branches and opening PRs is
outward-facing — confirm with the user first unless they passed `--push`.

### 10. Final report
`state <id> phase=complete`. Generalize this run's recurring issue types into reusable,
codebase-agnostic lessons ("missing authorization check on object-level access", not
"orders.py line 40 lacks owner check") and record them with
`legion-cli brownfield patterns --add "…" "…" --json`. Then report concisely:
1. Run id, effort, artifact folder (`.legion-cli/runs/<id>/`)
2. Verdict in two or three plain sentences — is this built soundly for its purpose?
3. Findings by severity, with the critical/major ones listed (file:line, one line each). Name
   specifics rather than categories — "`test_list_orders` asserts nothing" beats "tests are weak"
   — because the report is often the only thing the user reads.
4. Assumptions confirmed/rejected/still open
5. Design review rounds and outcome
6. PR plan (and, if executed: branches, review rounds, verify results, PR links or push command)
7. Suggested next step — including `legion-cli run promote <id>` if the user wants these pages in
   the project wiki (they land untrusted until `legion-cli wiki trust`)

## Ground rules
- **Secrets:** cite credentials by `file:line` only and write `[REDACTED]` instead of the value —
  in artifacts, agent prompts, and messages. Tell every specialist this.
- **Read-only until execute:** analysis, design, and review never modify project files. Only
  `.legion-cli/runs/<id>/` is written before phase 8, and the CLI writes its own bookkeeping there.
- **Utility over ceremony:** every PR in the plan must trace to an axiom (FP-n) or finding (F-n)
  and be worth its risk — `(people affected × utility gain) / risk`. Cosmetic churn and
  drive-by refactors get cut. This ranks work; it never waives the review exit bar.
- **Proportionality:** the process should cost roughly what the codebase warrants. Keep the PR
  plan within `size.maxPrs`; the fix for a small tool is a few focused PRs, not new
  infrastructure. Nothing goes in the plan (test harnesses, CI jobs, helper scripts) unless a
  finding requires it. On a large repo, give each specialist explicit directories in the plan
  rather than "the whole codebase".
- **The CLI's refusals are the product.** If a command refuses, relay its `error` and `next`; don't
  hand-edit state files to get past it.
