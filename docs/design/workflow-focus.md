# Legion CLI focused workflow

## Canonical product journey

Legion CLI guides a project through five visible commands:

```text
init → spec → plan → execute → ship
```

Bare `legion-cli` reports the current stage, the concrete blocker or pending
approval, and one next command. The workflow is local-first and CLI-owned;
dashboards and MCP surfaces may show state but do not become a second engine of
record.

| Command | User-facing responsibility | Required gate |
| --- | --- | --- |
| `init` | Select an adapter and greenfield or brownfield start; writes the focused profile. | Adapter selection |
| `spec` | Capture intent, investigate context, discuss consequential choices, challenge consequential assumptions, and write a reviewable contract. | `spec approve` |
| `plan` | Break the approved contract into bounded task contracts, planned checks, and acceptance criteria. | `plan approve` adopts focused workflow |
| `execute` | Complete approved tasks, checks, and independent review, or persist a concrete blocker. | Approved unchanged plan |
| `ship` | Present delivery evidence for human approval and optional delivery actions. | Human approval |

`intent`, `discuss`, `verify`, `review`, and `qa` are retained as advanced
inspection or recovery commands. They are not default waypoints. The focused
workflow invokes or records their responsibilities under `spec` and `execute`.
Numeric QA is legacy optional reporting, not the focused delivery gate.

## Starts and approvals

CLI-created projects use `workflow.profile: focused`. Existing low-level engine
configuration without that marker remains on the `legacy` profile for API
compatibility. `plan approve` explicitly adopts the focused profile for a
project's approved work. To migrate an existing CLI project, run `plan approve`:
it binds the current frozen spec, plan, and task artifacts without regenerating
them. CLI `execute` always requires a current plan approval; this deliberately
avoids an unguarded CLI fallback while direct legacy core APIs remain compatible.

`init` defaults to greenfield. `init --mode brownfield --brownfield-goal change`
discovers the code, tests, integrations, and current behavior relevant to a
scoped change before entering `spec`. `--brownfield-goal audit` gathers
evidenced findings, then persists a bounded remediation goal and affected
module paths before the interview begins. Unselected findings remain backlog
items. Neither starts implementation automatically.

The specialist `legion-cli brownfield` audit remains separate bookkeeping.
Its optional `--execute` creates reviewed per-PR worktrees at
`.legion-cli/worktrees/<run>/pr-N/`; the focused workflow's ordinary execute
remains in the current checkout.

`spec approve` freezes the feature contract. `plan approve` records the task
contracts, explicit automated checks (one quoted argv command per
`--check "command"`), and the acceptance criteria to be evidenced. A changed
spec, task contract, or plan invalidates the affected approval. A validated
amendment may be approved from `executing`; it refreshes the approval and the
affected evidence. `ship` requires human approval and never performs a commit,
PR, merge, or deployment implicitly.

Wireframes are opt-in through `spec --wireframes`. Stories, wireframes, pnpm,
Playwright, and browser checks are required only when the approved work needs
them.

Before a focused draft can freeze, `spec` performs one bounded challenge round.
The configured adapter may raise zero to three grounded concerns about
measurable success, failure handling, compatibility, and scope. A concern
includes its question, why it matters, and repository evidence or an explicit
assumption. The human must answer it, dismiss it with a reason, or accept its
risk; responses are persisted immediately. Once resolved, at most one synthesis
pass proposes permitted clarifications to acceptance criteria, constraints,
failure cases, and decisions. The CLI displays the resulting diff and the human
still runs `spec approve`.

Challenge evidence is bound to the draft, interview and decision context, and
reviewed source inputs. A later external edit starts a new bounded round on the
next explicit `spec` invocation; engine-applied synthesis updates the binding
without repeating the round. The challenge receipt is readable under
`.legion-cli/workflow/` and records the concerns, evidence, human responses,
dispositions, rationale, and draft changes. If automation fails or is
unavailable, `spec --manual-review` offers an explicit, recorded fallback using
fixed questions on measurable success, failure handling, and compatibility or
scope. Its acknowledgement is the exact token `I acknowledge`. It cannot
bypass unresolved concerns from a successful analysis.

Synthesis applies only validated clarifications that preserve the exact recorded
human answer text and stay within acceptance criteria, constraints, failure
cases, or decisions. A paraphrase, unrelated addition, requirement removal, or
identity/approval metadata change is rejected and requires the explicit manual
completion path instead.

## Execution and delivery evidence

`execute` runs ready work with one worker by default until all approved work is
complete or it reaches a failed check, review finding, unresolved decision, scope
change, sandbox incident, missing tool, or interruption. It saves the continuation
point. `execution.maxWorkers` can opt automatic execution into 1–4 workers;
explicit `--jobs <count>` requires `--until-blocked`. Parallel tasks must be
dependency-independent with disjoint contracts and separate jails; integration
is serialized with source-baseline checks, not concurrent writes to the checkout.
`execute --step` runs one ready task; `execute <taskId>` supports single-task
targeted recovery. `execute --retry` retries exactly one failed integration or
review stage; failed evidence otherwise stays blocked, never automatically retried.

Interrupted compatible HTTP jobs can use `execute --resume <runId>` with the
original jail and matching prompt/configuration/contracts/source identities.
Completed tools are not replayed; uncertain command or external-call effects
require operator reconciliation. While a spawn is live, process-identity run
markers refuse other mutations even when the engine lock is released.

Approved checks are trusted project code. One quoted argv command per `--check`
runs with credentials scrubbed under bwrap/seatbelt where available, explicitly
selected Docker, or the named host allowlist tier. An explicitly selected hardened
backend that is unavailable fails closed. Verification never uses a copy jail
or requires `--allow-no-sandbox`; filtering is not a trust boundary. QA unit
commands always run on the host. bwrap/seatbelt permit network egress.

The ship gate evaluates requirement-level evidence:

1. The approved plan's automated checks have current pass evidence.
2. Independent review has no unresolved findings.
3. Every acceptance criterion is marked pass, fail, or explicitly
   not-applicable with a note using `plan acceptance`.

Evidence is reusable only while the spec, plan, relevant source snapshot,
command, and execution context still match. Each integration command saves its
own resumable report, and independent review saves its report and fingerprint.
Review notes are written in the run cache and promoted by the engine into pinned
QA state. PASS requires exit 0, non-empty notes, no new tasks, unchanged existing
task files, and an explicit `Verdict: PASS` for focused evidence. Optional `verify`
walkthrough notes stay in run cache and are not approval/check evidence.
Failed or stale evidence blocks ship; changed staged product content also refuses
delivery. A repair or review finding becomes a proposed amendment; approving it
invalidates the affected plan/evidence instead of starting an automatic repair loop.

Product fingerprints still cover the whole product, not only task-owned files.
They include file contents, modes, missing tracked paths and symlink targets,
while retaining the existing bookkeeping and generated-path exclusions.
Hashing overlaps at most twelve selected paths at a time, preserves their
original record order and waits for started reads to finish before reporting
an I/O failure. This changes throughput, not fingerprint identities or reuse
eligibility; it does not make a filesystem snapshot atomic.

Focused `fix --profile <name>` and `fix --adapter <id>` retain the selected task
routing on the proposed amendment; they do not execute it. Unknown or conflicting
selections refuse before invalidating existing review evidence. After renewed plan
approval, execution uses the persisted selection unless explicitly overridden.

Advisory mode refuses explicit execution before approval or integration work,
including when every task is already complete. Focused status still leads through
missing spec/plan approvals; an execution-ready next command instead requests
`control-mode guarded`.

Legacy numeric QA remains optional for focused delivery; when used, its v2
AC-linked reports retain SPEC/source freshness, missing/skipped P0 refusal,
runner-failure blocking, and explicit degraded-workflow rules.

## Implementation acceptance checklist

This guide describes the intended behavior. The implementation is accepted
only after these checks have evidence; this document does not claim they have
passed.

- [ ] Default help and bare status lead users through only the five commands.
- [ ] Greenfield, brownfield `change`, and brownfield `audit` converge at
  `spec`; audit persists a bounded goal and affected paths, leaving remaining
  findings as backlog.
- [ ] Spec and plan approvals reject stale or changed inputs.
- [ ] Execute supports complete-run, one-step, targeted-recovery, and explicit
  single-stage retry paths; it records resumable command and review evidence.
- [ ] Planned checks, review, and manual acceptance evidence determine ship;
  non-UI/non-JavaScript fixtures do not need wireframes or pnpm/Playwright.
- [ ] Existing advanced commands, sandbox and file-contract enforcement,
  adapter rules, publishing safeguards, legacy projects, and brownfield
  worktrees continue to work.

Run focused end-to-end, approval-invalidation, interruption/resume,
failed-review, and help/transcript tests once for the implementation revision,
then typecheck and the required platform checks. Repeat only after a concrete
related change or failure.
